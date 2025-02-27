import { Channel, ChannelExecution } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import * as FormData from 'form-data'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import { ModelsManager } from '../../models/manager'
import { Type } from '../../models/types'
import { Op } from 'sequelize'
import { ItemRelation } from '../../models/itemRelations'

interface JobContext {
    log: string
}

export class OzonChannelHandler extends ChannelHandler {
    private cache = new NodeCache();

    public async processChannel(channel: Channel, language: string, data: any): Promise<void> {
        const chanExec = await this.createExecution(channel)
      
        const context: JobContext = {log: ''}

        if (!channel.config.ozonClientId) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен Client Id в конфигурации канала')
            return 
        }
        if (!channel.config.ozonApiKey) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен API key в конфигурации канала')
            return 
        }
        if (!channel.config.ozonIdAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где хранить Ozon ID')
            return 
        }

        try {
            if (!data) {
                const query:any = {}
                query[channel.identifier] = {status: 1}
                let items = await Item.findAndCountAll({ 
                    where: { tenantId: channel.tenantId, channels: query} 
                })
                context.log += 'Запущена выгрузка на Ozon\n'
                context.log += 'Найдено ' + items.count +' записей для обработки \n\n'
                for (let i = 0; i < items.rows.length; i++) {
                    const item = items.rows[i];
                    await this.processItem(channel, item, language, context)
                    context.log += '\n\n'
                }
            } else if (data.sync) {
                await this.syncJob(channel, context, data)
            } else if (data.clearCache) {
                this.cache.flushAll()
                context.log += 'Кеш очищен'
            }

            await this.finishExecution(channel, chanExec, 2, context.log)
        } catch (err) {
            logger.error("Error on channel processing", err)
            context.log += 'Ошибка запуска канала - '+ JSON.stringify(err)
            await this.finishExecution(channel, chanExec, 3, context.log)
        }
    }

    async syncJob(channel: Channel, context: JobContext, data: any) {
        context.log += 'Запущена синхронизация с Ozon\n'

        if (data.item) {
            const item = await Item.findByPk(data.item)
            await this.syncItem(channel, item!, context, true)
        } else {
            const query:any = {}
            query[channel.config.ozonIdAttr] = { [Op.ne]: '' }
            let items = await Item.findAll({ 
                where: { tenantId: channel.tenantId, values: query} 
            })
            context.log += 'Найдено ' + items.length +' записей для обработки \n\n'
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                await this.syncItem(channel, item, context, false)
            }
        }
        context.log += 'Cинхронизация закончена'
    }

    async syncItem(channel: Channel, item: Item, context: JobContext, singleSync: boolean) {
        context.log += 'Обрабатывается товар c идентификатором: [' + item.identifier + ']\n'

        if (item.values[channel.config.ozonIdAttr] && item.channels[channel.identifier]) {
            const chanData = item.channels[channel.identifier]
            if (!singleSync && chanData.status === 3) {
                context.log += 'Статус товара - ошибка, синхронизация не будет проводиться \n'
                return
            }

            const tst = ''+item.values[channel.config.ozonIdAttr]
            if (tst.startsWith('task_id=')) {
                // receive product id first
                const taskId = tst.substring(8)
                const log2 = "Sending request to Ozon to check task id: " + taskId
                logger.info(log2)
                if (channel.config.debug) context.log += log2+'\n'
                const res2 = await fetch('https://api-seller.ozon.ru/v1/product/import/info', {
                    method: 'post',
                    body:    JSON.stringify({task_id: taskId}),
                    headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                })
                if (res2.status !== 200) {
                    const text = await res2.text()
                    const msg = 'Ошибка запроса на Ozon: ' + res2.statusText + "   " + text
                    context.log += msg                      
                    this.reportError(channel, item, msg)
                    logger.error(msg)
                    return
                } else {
                    const json2 = await res2.json()
                    const log3 = "Response 2 from Ozon: " + JSON.stringify(json2) 
                    logger.info(log3)
                    if (channel.config.debug) context.log += log3+'\n'
                    if (json2.result.items.length === 0 || json2.result.items[0].product_id == 0) {
                        context.log += '  товар c идентификатором ' + item.identifier + ' пока не получил product_id \n'
                        return
                    } else {
                        item.values[channel.config.ozonIdAttr] = json2.result.items[0].product_id
                        item.changed('values', true)
                    }
                }
            }

            const tst2 = ''+item.values[channel.config.ozonIdAttr]
            if (tst2.startsWith('task_id=')) return

            // try to find current status
            const url = 'https://api-seller.ozon.ru/v2/product/info'
            const request = {
                "product_id": item.values[channel.config.ozonIdAttr]
            }
            const log = "Sending request Ozon: " + url + " => " + JSON.stringify(request)
            logger.info(log)
            if (channel.config.debug) context.log += log+'\n'
            const res = await fetch(url, {
                method: 'post',
                body: JSON.stringify(request),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            if (res.status !== 200) {
                const msg = 'Ошибка запроса на Ozon: ' + res.statusText
                context.log += msg
                return
            } else {
                const data = await res.json()
                logger.info('   received data: ' + JSON.stringify(data))
                const result = data.result
                context.log += '   статус товара: ' + JSON.stringify(result.status)

                if (result.status.is_created && !result.status.is_failed && result.status.moderate_status !== 'declined') {
                    item.channels[channel.identifier].status = 2
                    item.channels[channel.identifier].message = JSON.stringify(result.status)
                    item.channels[channel.identifier].syncedAt = new Date().getTime()
                    item.changed('channels', true)

                    logger.info('   product sources: ' + JSON.stringify(result.sources))
                    context.log += '   sources: ' + JSON.stringify(result.sources)

                    if (channel.config.ozonFBSIdAttr) {
                        const fbs = result.sources.find((elem: any) => elem.source === 'fbs')
                        if (fbs) {
                            item.values[channel.config.ozonFBSIdAttr] = fbs.sku
                            item.changed('values', true)
                        }
                    }
                    if (channel.config.ozonFBOIdAttr) {
                        const fbo = result.sources.find((elem: any) => elem.source === 'fbo')
                        if (fbo) {
                            item.values[channel.config.ozonFBOIdAttr] = fbo.sku
                            item.changed('values', true)
                        }
                    }
                } else if (result.status.is_failed || result.status.moderate_status === 'declined') {
                    item.channels[channel.identifier].status = 3
                    item.channels[channel.identifier].message = JSON.stringify(result.status)
                    item.channels[channel.identifier].syncedAt = new Date().getTime()
                    item.changed('channels', true)
                } else {
                    item.channels[channel.identifier].status = 4
                    item.channels[channel.identifier].message = 'Модерация: ' + JSON.stringify(result.status)
                    item.channels[channel.identifier].syncedAt = new Date().getTime()
                    item.changed('channels', true)
                }
            }

            await this.saveItemIfChanged(channel, item)

            context.log += '  товар c идентификатором ' + item.identifier + ' синхронизирован \n'
        } else {
            context.log += '  товар c идентификатором ' + item.identifier + ' не требует синхронизации \n'
        }

    }

    async processItem(channel: Channel, item: Item, language: string, context: JobContext) {
        context.log += 'Обрабатывается запись с идентификатором: ' + item.identifier +'\n'

        for (const categoryId in channel.mappings) {
            const categoryConfig = channel.mappings[categoryId]

            if (categoryConfig.valid && categoryConfig.valid.length > 0 && ( 
                (categoryConfig.visible && categoryConfig.visible.length > 0) || categoryConfig.categoryExpr || (categoryConfig.categoryAttr && categoryConfig.categoryAttrValue)) ) {
                const pathArr = item.path.split('.')
                const tstType = categoryConfig.valid.includes(item.typeId) || categoryConfig.valid.includes(''+item.typeId)
                if (tstType) {
                    let tst = null
                    if (categoryConfig.visible && categoryConfig.visible.length > 0) {
                        if (categoryConfig.visibleRelation) {
                            let sources = await Item.findAll({ 
                                where: { tenantId: channel.tenantId, '$sourceRelation.relationId$': categoryConfig.visibleRelation, '$sourceRelation.targetId$': item.id },
                                include: [{model: ItemRelation, as: 'sourceRelation'}]
                            })
                            tst = sources.some(source => {
                                const pathArr = source.path.split('.')
                                return categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
                            })
                        } else {
                            tst = categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
                        }
                    } else if (categoryConfig.categoryExpr) {
                        tst = await this.evaluateExpression(channel, item, categoryConfig.categoryExpr)
                    } else {
                        tst = item.values[categoryConfig.categoryAttr] && item.values[categoryConfig.categoryAttr] == categoryConfig.categoryAttrValue
                    }
                    if (tst) {
                        try {
                            const changedValues = await this.processItemInCategory(channel, item, categoryConfig, language, context)

                            await this.saveItemIfChanged(channel, item, changedValues)
                        } catch (err) {
                            logger.error("Failed to process item with id: " + item.id + " for tenant: " + item.tenantId, err)

                            const data = item.channels[channel.identifier]
                            data.status = 3
                            data.message = 'Ошибка обработки товара: ' + err
                            context.log += data.message
                            await this.saveItemIfChanged(channel, item)
                        }
                        return
                    }
                }
            } else {
                // context.log += 'Запись с идентификатором: ' + item.identifier + ' не подходит под конфигурацию категории: '+categoryConfig.name+' \n'
                // logger.warn('No valid/visible configuration for : ' + channel.identifier + ' for item: ' + item.identifier + ', tenant: ' + channel.tenantId)
            }
        }

        const data = item.channels[channel.identifier]
        data.status = 3
        data.message = 'Этот объект не подходит ни под одну категорию из этого канала.'
        context.log += 'Запись с идентификатором:' + item.identifier + ' не подходит ни под одну категорию из этого канала.\n'
        await this.saveItemIfChanged(channel, item)
    }

    async saveItemIfChanged(channel: Channel, item: Item, changedValues:any = null) {
        const reloadedItem = await Item.findByPk(item.id) // refresh item from DB (other channels can already change it)
        let changed = false
        let valuesChanged = false
        const data = item.channels[channel.identifier]
        const reloadedData = reloadedItem!.channels[channel.identifier]
        if (reloadedData.status !== data.status || reloadedData.message !== data.message) {
            changed = true
            reloadedData.status = data.status
            reloadedData.message = data.message
            if (data.syncedAt) reloadedData.syncedAt = data.syncedAt
            reloadedItem!.changed('channels', true)
        }
        if (reloadedItem!.values[channel.config.ozonIdAttr] !== item.values[channel.config.ozonIdAttr]) {
            changed = true
            valuesChanged = true
            reloadedItem!.values[channel.config.ozonIdAttr] = item.values[channel.config.ozonIdAttr]
            reloadedItem!.changed('values', true)
        }
        if (reloadedItem!.values[channel.config.ozonFBSIdAttr] !== item.values[channel.config.ozonFBSIdAttr]) {
            changed = true
            valuesChanged = true
            reloadedItem!.values[channel.config.ozonFBSIdAttr] = item.values[channel.config.ozonFBSIdAttr]
            reloadedItem!.changed('values', true)
        }
        if (reloadedItem!.values[channel.config.ozonFBOIdAttr] !== item.values[channel.config.ozonFBOIdAttr]) {
            changed = true
            valuesChanged = true
            reloadedItem!.values[channel.config.ozonFBOIdAttr] = item.values[channel.config.ozonFBOIdAttr]
            reloadedItem!.changed('values', true)
        }
        if (changedValues && Object.keys(changedValues).length > 0) {
            changed = true
            valuesChanged = true
            for (const prop in changedValues) {
                reloadedItem!.values[prop] = changedValues[prop]
            }
            reloadedItem!.changed('values', true)
        }
        if (changed) {
            if (valuesChanged) { // hardcore for MS
                if (reloadedItem!.channels['ms'] && reloadedItem!.channels['ms'].status) {
                    reloadedItem!.channels['ms'] = {status: 1, submittedAt: Date.now(), submittedBy: "system", message: ""}
                    reloadedItem!.changed('channels', true)
                }
            }
            await sequelize.transaction(async (t) => {
                await reloadedItem!.save({transaction: t})
            })
        }
    }

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any, language: string, context: JobContext) {
        context.log += 'Найдена категория "' + categoryConfig.name +'" для записи с идентификатором: ' + item.identifier + '\n'

        const changedValues:any = {}

        const data = item.channels[channel.identifier]
        data.category = categoryConfig.id

        // request to Ozon
        const product:any = {attributes:[]}
        const request:any = {items:[product]}

        const productCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#productCode')
        const productCode = await this.getValueByMapping(channel, productCodeConfig, item, language)
        if (!productCode) {
            const msg = 'Не введена конфигурация или нет данных для "Артикула товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const vatConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#vat')
        const vat = await this.getValueByMapping(channel, vatConfig, item, language)
        if (!vat) {
            const msg = 'Не введена конфигурация или нет данных для "НДС" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const barcodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#barcode')
        const barcode = await this.getValueByMapping(channel, barcodeConfig, item, language)
        if (!barcode) {
            const msg = 'Не введена конфигурация или нет данных для "Баркода" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const priceConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#price')
        const price = await this.getValueByMapping(channel, priceConfig, item, language)
        if (!price) {
            const msg = 'Не введена конфигурация или нет данных для "Цены" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const depthConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#depth')
        const depth = await this.getValueByMapping(channel, depthConfig, item, language)
        if (!depth) {
            const msg = 'Не введена конфигурация или нет данных для "Длина упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const widthConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#width')
        const width = await this.getValueByMapping(channel, widthConfig, item, language)
        if (!width) {
            const msg = 'Не введена конфигурация или нет данных для "Ширина упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const heightConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#height')
        const height = await this.getValueByMapping(channel, heightConfig, item, language)
        if (!height) {
            const msg = 'Не введена конфигурация или нет данных для "Высота упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const weightConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#weight')
        const weight = await this.getValueByMapping(channel, weightConfig, item, language)
        if (!weight) {
            const msg = 'Не введена конфигурация или нет данных для "Вес с упаковкой" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const nameConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#name')
        const name = await this.getValueByMapping(channel, nameConfig, item, language)
        if (!name) {
            const msg = 'Не введена конфигурация или нет данных для "Названия товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const ozonCategoryId = parseInt(categoryConfig.id.substring(4))
        product.category_id = ozonCategoryId
        product.offer_id = productCode
        product.barcode = barcode
        product.price = price
        product.weight = weight
        product.weight_unit = 'g'
        product.depth = depth
        product.height = height
        product.width = width
        product.dimension_unit = 'mm'
        product.vat = vat
        product.name = name

        const priceOldConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#oldprice')
        const priceOld = await this.getValueByMapping(channel, priceOldConfig, item, language)
        if (priceOld) product.old_price = priceOld

        const pricePremConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#premprice')
        const pricePrem = await this.getValueByMapping(channel, pricePremConfig, item, language)
        if (pricePrem) product.premium_price = pricePrem

        // video processing
        const complex_attributes:any = [{attributes:[]}]
        let wasData = false
        const videoUrlsConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#videoUrls')
        let videoUrlsValue = await this.getValueByMapping(channel, videoUrlsConfig, item, language)
        if (videoUrlsValue) {
            if (!Array.isArray(videoUrlsValue)) videoUrlsValue = [videoUrlsValue]
            const videos = {
                "complex_id": 4018,
                "id": 4074,
                "values": videoUrlsValue.map((elem:any) => { return { value: elem } })
              }
              complex_attributes[0].attributes.push(videos)
              wasData = true
        }
        const videoNamesConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#videoNames')
        let videoNamesValue = await this.getValueByMapping(channel, videoNamesConfig, item, language)
        if (videoNamesValue) {
            if (!Array.isArray(videoNamesValue)) videoNamesValue = [videoNamesValue]
            const videoNames = {
                "complex_id": 4018,
                "id": 4068,
                "values": videoNamesValue.map((elem:any) => { return { value: elem } })
              }
              complex_attributes[0].attributes.push(videoNames)
              wasData = true
        }
        if (wasData) product.complex_attributes = complex_attributes

        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (
                attrConfig.id != '#productCode' && attrConfig.id != '#name' && attrConfig.id != '#barcode' && attrConfig.id != '#price' && attrConfig.id != '#oldprice' && attrConfig.id != '#premprice' && 
                attrConfig.id != '#weight' && attrConfig.id != '#depth' && attrConfig.id != '#height' && attrConfig.id != '#width' && attrConfig.id != '#vat'
                && attrConfig.id != '#videoUrls' && attrConfig.id != '#videoNames' && attrConfig.id != '#images360Urls'
            ) {
                const attr = (await this.getAttributes(channel, categoryConfig.id)).find(elem => elem.id === attrConfig.id)
                if (!attr) {
                    logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                    continue
                }
                try {
                    let value = await this.getValueByMapping(channel, attrConfig, item, language)
                    if (value) {
                        if (typeof value === 'string' || value instanceof String) value = value.trim()
                        const ozonAttrId = parseInt(attrConfig.id.substring(5))
                        const data = {complex_id:0, id: ozonAttrId, values: <any[]>[]}
                        if (Array.isArray(value)) {
                            for (let j = 0; j < value.length; j++) {
                                let elem = value[j];
                                if (elem && (typeof elem === 'string' || elem instanceof String)) elem = elem.trim()
                                const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonAttrId, attr.dictionary, elem, attrConfig.options)
                                if (!ozonValue) {
                                    const msg = 'Значение "' + elem + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                                    context.log += msg                      
                                    this.reportError(channel, item, msg)
                                    return
                                }
                                data.values.push(ozonValue)
                            }
                        } else if (typeof value === 'object') {
                            data.values.push(value)
                        } else {
                            const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonAttrId, attr.dictionary, value, attrConfig.options)
                            if (!ozonValue) {
                                const msg = 'Значение "' + value + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                                context.log += msg                      
                                this.reportError(channel, item, msg)
                                return
                            }
                            data.values.push(ozonValue)
                        }
                        product.attributes.push(data)
                    } else if (attr.required) {
                        const msg = 'Нет значения для обязательного атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                        context.log += msg                      
                        this.reportError(channel, item, msg)
                        return
                    }
                } catch (err:any) {
                    const msg = 'Ошибка вычисления атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                    logger.error(msg, err)
                    context.log += msg + ': ' + err.message        
                    this.reportError(channel, item, msg + ': ' + err.message)
                    return
                  }
            }
        }
        
        await this.processItemImages(channel, item, context, product)

        // images 360 processing
        const images360UrlsConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#images360Urls')
        let images360UrlsValue = await this.getValueByMapping(channel, images360UrlsConfig, item, language)
        if (images360UrlsValue) {
            if (!Array.isArray(images360UrlsValue)) images360UrlsValue = [images360UrlsValue]
            product.images360 = images360UrlsValue
        }

        const ozonProductId = item.values[channel.config.ozonIdAttr]
        if (ozonProductId) {
            // check if we have changed prices that we should leave unchanged
            const existingPricesReq = {product_id: ozonProductId}
            const existingPricesUrl = 'https://api-seller.ozon.ru/v2/product/info'
            const logPr = "Sending request to Ozon: " + existingPricesUrl + " => " + JSON.stringify(existingPricesReq)
            logger.info(logPr)
            if (channel.config.debug) context.log += logPr+'\n'
            const existingPricesRes = await fetch(existingPricesUrl, {
                method: 'post',
                body:    JSON.stringify(existingPricesReq),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            logger.info("Response status from Ozon: " + existingPricesRes.status)
            if (existingPricesRes.status !== 200) {
                const text = await existingPricesRes.text()
                const msg = 'Ошибка запроса на Ozon: ' + existingPricesRes.statusText + "   " + text
                context.log += msg                      
                this.reportError(channel, item, msg)
                logger.error(msg)
                return
            } else {
                const existingPricesJson = await existingPricesRes.json()

                const priceAttr = priceConfig.attrIdent
                if (priceAttr && item.values[priceAttr] != parseFloat(existingPricesJson.result.price)) {
                    changedValues[priceAttr] = parseFloat(existingPricesJson.result.price)
                    product.price = existingPricesJson.result.price
                }
                const priceOldAttr = priceOldConfig?.attrIdent
                if (priceOldAttr && existingPricesJson.result.old_price && item.values[priceOldAttr] != parseFloat(existingPricesJson.result.old_price)) {
                    changedValues[priceOldAttr] = parseFloat(existingPricesJson.result.old_price)
                    product.old_price = existingPricesJson.result.old_price
                }
                const pricePremAttr = pricePremConfig?.attrIdent
                if (pricePremAttr && existingPricesJson.result.premium_price && item.values[pricePremAttr] != parseFloat(existingPricesJson.result.premium_price)) {
                    changedValues[pricePremAttr] = parseFloat(existingPricesJson.result.premium_price)
                    product.premium_price = existingPricesJson.result.premium_price
                }
            }
            
            // check if we have loaded videos that we should leave unchanged
            const existingDataReq = {
                "filter": {
                    "product_id": [ozonProductId],
                    "visibility": "ALL"
                },
                "limit": 1000
            }
            const existingDataUrl = 'https://api-seller.ozon.ru/v3/products/info/attributes'
            const log = "Sending request to Ozon: " + existingDataUrl + " => " + JSON.stringify(existingDataReq)
            logger.info(log)
            if (channel.config.debug) context.log += log+'\n'
            const existingDataRes = await fetch(existingDataUrl, {
                method: 'post',
                body:    JSON.stringify(existingDataReq),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            logger.info("Response status from Ozon: " + existingDataRes.status)
            if (existingDataRes.status !== 200) {
                const text = await existingDataRes.text()
                const msg = 'Ошибка запроса на Ozon: ' + existingDataRes.statusText + "   " + text
                context.log += msg                      
                this.reportError(channel, item, msg)
                logger.error(msg)
                return
            } else {
                const existingDataJson = await existingDataRes.json()
                // const log = "Response from Ozon: " + JSON.stringify(existingDataJson)
                // logger.info(log)
                // if (channel.config.debug) context.log += log+'\n'
                let videoElem1
                let videoElem2
                if (existingDataJson.result[0].complex_attributes) {
                    existingDataJson.result[0].complex_attributes.forEach((elem:any) => {
                        const data1 = elem.attributes.find((elem1:any) => elem1.attribute_id === 21837)
                        if (data1) {
                            delete(data1.attribute_id)
                            data1.id = 21837
                            videoElem1 = data1
                        }

                        const data2 = elem.attributes.find((elem2:any) => elem2.attribute_id === 21841)
                        if (data2) {
                            delete(data2.attribute_id)
                            data2.id = 21841
                            videoElem2 = data2
                        }

                    })
                }
                if (videoElem1 && videoElem2) {
                    const log = "Найдены загруженные видео: \n" + JSON.stringify(videoElem1) + "\n" + JSON.stringify(videoElem2)
                    logger.info(log)
                    if (channel.config.debug) context.log += log+'\n'
                    if (!product.complex_attributes) product.complex_attributes = [{attributes:[]}]
                    product.complex_attributes[0].attributes.push(videoElem1)
                    product.complex_attributes[0].attributes.push(videoElem2)
                } else {
                    const log = "Загруженные видео не найдены"
                    logger.info(log)
                    if (channel.config.debug) context.log += log+'\n'
                }
            }
        }

        const url = 'https://api-seller.ozon.ru/v2/product/import'
        const log = "Sending request to Ozon: " + url + " => " + JSON.stringify(request)
        logger.info(log)
        if (channel.config.debug) context.log += log+'\n'

        const res = await fetch(url, {
            method: 'post',
            body:    JSON.stringify(request),
            headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
        })
        logger.info("Response status from Ozon: " + res.status)
        if (res.status !== 200) {
            const text = await res.text()
            const msg = 'Ошибка запроса на Ozon: ' + res.statusText + "   " + text
            context.log += msg                      
            this.reportError(channel, item, msg)
            logger.error(msg)
            return
        } else {
            const json = await res.json()
            const log = "Response from Ozon: " + JSON.stringify(json)
            logger.info(log)
            if (channel.config.debug) context.log += log+'\n'

            await this.sleep(2000)
            
            const taskId = json.result.task_id
            const log2 = "Sending request to Ozon to check task id: " + taskId
            logger.info(log2)
            if (channel.config.debug) context.log += log2+'\n'
            const res2 = await fetch('https://api-seller.ozon.ru/v1/product/import/info', {
                method: 'post',
                body:    JSON.stringify({task_id: taskId}),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            if (res2.status !== 200) {
                const text = await res2.text()
                const msg = 'Ошибка запроса на Ozon: ' + res2.statusText + "   " + text
                context.log += msg                      
                this.reportError(channel, item, msg)
                logger.error(msg)
                return
            } else {    
                const json2 = await res2.json()
                const log3 = "Response 2 from Ozon: " + JSON.stringify(json2) 
                logger.info(log3)
                if (channel.config.debug) context.log += log3+'\n'
    
                let status = null
                let errors = null
                if (json2.result.items && json2.result.items.length > 0) {
                    status = json2.result.items[0].status
                    errors = json2.result.items[0].errors
                }
                const data = item.channels[channel.identifier]
                if (status === 'imported') {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана успешно.\n'
                    data.status = 4
                    data.message = 'Товар находится на модерации ' + errors && errors.length > 0? JSON.stringify(errors) :''
                    data.syncedAt = Date.now()
                    item.changed('channels', true)
                    if (json2.result.items[0].product_id == 0) {
                        item.values[channel.config.ozonIdAttr] = 'task_id='+taskId
                    } else {
                        item.values[channel.config.ozonIdAttr] = json2.result.items[0].product_id
                    }
                    item.changed('values', true)
                } else if (status === 'failed') {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана с ошибкой.\n'
                    data.status = 3
                    data.message = errors && errors.length > 0? 'Ошибки:'+JSON.stringify(errors) :''
                    item.changed('channels', true)            
                } else {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана со статусом: ' + status + ' \n'
                    data.status = 4
                    data.message = ''
                    item.changed('channels', true)            
                    if (status === null || json2.result.items[0].product_id == 0) {
                        item.values[channel.config.ozonIdAttr] = 'task_id='+taskId
                    } else {
                        item.values[channel.config.ozonIdAttr] = json2.result.items[0].product_id
                    }
                    item.changed('values', true)
                }
            }
        }

        return changedValues
    }

    async processItemImages(channel: Channel, item: Item, context: JobContext, product: any) {
        if (channel.config.imgRelations && channel.config.imgRelations.length > 0) {
            const mng = ModelsManager.getInstance().getModelManager(channel.tenantId)
            const typeNode = mng.getTypeById(item.typeId)
            if (!typeNode) {
                throw new Error('Failed to find type by id: ' + item.typeId + ', tenant: ' + mng.getTenantId())
            }
            const type:Type = typeNode.getValue()

            const data:string[] = [] 
            if (type.mainImage && channel.config.imgRelations.includes(type.mainImage)) {
                const images: Item[] = await sequelize.query(
                    `SELECT a.*
                        FROM "items" a, "itemRelations" ir, "types" t where 
                        a."tenantId"=:tenant and 
                        ir."itemId"=:itemId and
                        a."id"=ir."targetId" and
                        a."typeId"=t."id" and
                        t."file"=true and
                        coalesce(a."storagePath", '') != '' and
                        ir."deletedAt" is null and
                        a."deletedAt" is null and
                        ir."relationId" = :relation
                        order by ir.values->'_itemRelationOrder', a.id`, {
                    model: Item,
                    mapToModel: true,                     
                    replacements: { 
                        tenant: channel.tenantId,
                        itemId: item.id,
                        relation: type.mainImage
                    }
                })
                if (images) {
                    for (let i = 0; i < images.length; i++) {
                        const image = images[i];
                        const url = image.values[channel.config.ozonImageAttr]
                        if (url && !product.primary_image) {
                            product.primary_image = url
                        } else {
                            data.push(url)
                        }
                    }
                }
            }

            const rels = channel.config.imgRelations.filter((elem:any) => elem !== type.mainImage)
            if (rels.length > 0) {
                const images: Item[] = await sequelize.query(
                    `SELECT a.*
                        FROM "items" a, "itemRelations" ir, "types" t where 
                        a."tenantId"=:tenant and 
                        ir."itemId"=:itemId and
                        a."id"=ir."targetId" and
                        a."typeId"=t."id" and
                        t."file"=true and
                        coalesce(a."storagePath", '') != '' and
                        ir."deletedAt" is null and
                        a."deletedAt" is null and
                        ir."relationId" in (:relations)
                        order by ir.values->'_itemRelationOrder', a.id`, {
                    model: Item,
                    mapToModel: true,                     
                    replacements: { 
                        tenant: channel.tenantId,
                        itemId: item.id,
                        relations: rels
                    }
                })
                if (images) {
                    for (let i = 0; i < images.length; i++) {
                        const image = images[i];
                        if (image.values[channel.config.ozonImageAttr]) data.push(image.values[channel.config.ozonImageAttr])
                    }
                }
            }
            if (data.length > 0) product.images = data
        }
    }    
    private async generateValue(channel: Channel, ozonCategoryId: number, ozonAttrId: number, dictionary: boolean, value: any, options: any) {
        if (dictionary) {
            if (options) {
                const tst = options.find((elem:any) => elem.name === value)
                if (tst) return {dictionary_value_id: tst.value, value: value}
            }
            let dict: any[] | string | undefined = this.cache.get('dict_'+ozonCategoryId+'_'+ozonAttrId)
            if (!dict) {
                dict = []
                let next = false
                let last = 0
                let idx = 0
                do {
                    const body = {
                        "attribute_id": ozonAttrId,
                        "category_id": ozonCategoryId,
                        "language": "DEFAULT",
                        "last_value_id": last,
                        "limit": 5000
                    }
                    // console.log('request to https://api-seller.ozon.ru/v2/category/attribute/values '+JSON.stringify(body))
                    const res = await fetch('https://api-seller.ozon.ru/v2/category/attribute/values', {
                        method: 'post',
                        body:    JSON.stringify(body),
                        headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                    })
                    const json = await res.json()
                    // console.log('response: '+JSON.stringify(json))
                    dict = dict.concat(json.result)
                    next = json.has_next
                    if (dict.length === 0) throw new Error('No data for attribute dictionary: '+ozonAttrId+', for category: '+ozonCategoryId)
                    last = dict[dict.length-1]?.id
                    if (idx++ > 25) {
                        this.cache.set('dict_'+ozonCategoryId+'_'+ozonAttrId, 'big', 3600)
                        throw new Error('Data dictionary for attribute: '+ozonAttrId+' is too big, for category: '+ozonCategoryId)
                    }
                } while (next)
    
                this.cache.set('dict_'+ozonCategoryId+'_'+ozonAttrId, dict, 3600)
            } else if (dict === 'big') {
                throw new Error('Data dictionary for attribute: '+ozonAttrId+' is too big, for category: '+ozonCategoryId)
            }

            const entry = (dict as any[])!.find((elem:any) => elem.value === value)
            if (!entry) {
                return null
            } else {
                return {dictionary_value_id: entry.id, value: value}
            }
        } else {
            return { value: ''+value }
        }
    }

    public async getCategories(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}> {
        if (!channel.config.ozonClientId) throw new Error('Не введен Client Id в конфигурации канала.')
        if (!channel.config.ozonApiKey) throw new Error('Не введен Api Key в конфигурации канала.')

        let tree:ChannelCategory | undefined = this.cache.get('categories')
        if (! tree) {
            tree  = {id: '', name: 'root', children: []}
            const res = await fetch('https://api-seller.ozon.ru/v2/category/tree?language=DEFAULT', {
                method: 'post',
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            const json = await res.json()
            this.collectTree(json.result, tree)
            this.cache.set('categories', tree, 3600)
        }
        return {list: null, tree: tree}
    }
    private collectAllLeafs(arr: any[], data: ChannelCategory[]) {
        arr.forEach(elem => {
          if (elem.children) {
              if (elem.children.length > 0) {
                this.collectAllLeafs(elem.children, data)
              } else {
                data.push({id: 'cat_' + elem.category_id, name: elem.title})
              }
          }  
        })
    }
    private collectTree(arr: any[], treeNode: ChannelCategory) {
        arr.forEach(elem => {
            const child = {id: 'cat_' + elem.category_id, name: elem.title, children: []}
            treeNode.children!.push(child)
            if (elem.children) {
                if (elem.children.length > 0) {
                    this.collectTree(elem.children, child)
                }
            }  
        })
    }
    
    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (! data) {
            const query = {
                attribute_type: "ALL",
                category_id: [categoryId.substring(4)],
                language: "DEFAULT"
              }
              logger.info("Sending request to Ozon: https://api-seller.ozon.ru/v3/category/attribute => " + JSON.stringify(query))
              const res = await fetch('https://api-seller.ozon.ru/v3/category/attribute', {
                method: 'post',
                body:    JSON.stringify(query),
                headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            if (res.status !== 200) {
                const text = await res.text()
                throw new Error("Failed to query attributes with error: " + res.statusText+", text: " + text)
            }
            const json = await res.json()

            data = json.result[0].attributes.map((elem:any) => { 
                return { 
                    id: 'attr_' + elem.id, 
                    name: elem.name + ' ('+ elem.type + ')',
                    required: elem.is_required,
                    category: categoryId,
                    description: elem.description+'\n id: '+elem.id+', category: '+categoryId,
                    dictionary: elem.dictionary_id !== 0,
                    dictionaryLinkPost: elem.dictionary_id !== 0 ? { body: {
                        attribute_id: elem.id,
                        category_id: categoryId.substring(4),
                        language: "DEFAULT",
                        last_value_id: 0,
                        limit: 1000
                      }, headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey } } : null,
                    dictionaryLink: elem.dictionary_id !== 0 ? 'https://api-seller.ozon.ru/v2/category/attribute/values' : null
                } 
            } )


            this.cache.set('attr_'+categoryId, data, 3600)
        }
        return <ChannelAttribute[]>data
    }

    public async getChannelAttributeValues(channel: Channel, categoryId: string, attributeId: string): Promise<any> {
        const attrs = await this.getAttributes(channel, categoryId)
        const attr = attrs.find(elem => elem.id === attributeId)
        if (attr && attr.dictionaryLinkPost) {
            const resp =await fetch(attr.dictionaryLink!, {
                method: 'POST',
                headers: attr.dictionaryLinkPost.headers,
                body: JSON.stringify(attr.dictionaryLinkPost.body)
              })
            return await resp.json()
        }
        return {}
    }
}
