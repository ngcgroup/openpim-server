import logger from "../logger"
import { WhereOptions } from 'sequelize'
import { Channel } from "../models/channels"
import { scheduleJob, Range, Job } from 'node-schedule'
import { Item } from "../models/items"
import { fn } from 'sequelize'
import { ChannelHandler } from "./ChannelHandler"
import { ExtChannelHandler } from "./ext/ExtChannelHandler"
import { WBChannelHandler } from "./wb/WBChannelHandler"
import { WBNewChannelHandler } from "./wb/WBNewChannelHandler"
import { OzonChannelHandler } from "./ozon/OzonChannelHandler"
import { YMChannelHandler } from "./ym/YMChannelHandler"

export class ChannelsManager {
    private tenantId: string
    private jobMap: Record<string, [Job|null, boolean]> = {}

    public constructor(tenantId: string) { this.tenantId = tenantId }
    public getTenantId() { return this.tenantId }

    public addChannel(channel: Channel) {
        this.startChannel(channel)
    }

    public stopChannel(channel: Channel) {
        const tst = this.jobMap[channel.identifier]
        if (tst && tst[0]) tst[0].cancel()
    }

    public async triggerChannel(channel: Channel,language: string, data: any) {
        logger.info("Channel " + channel.identifier + " was triggered, tenant: " + this.tenantId)

        if (!language) {
            logger.error("Failed to find language for automatic start for channel " + channel.identifier + ", processing stopped, tenant: " + this.tenantId)
            return
        }

        let jobDetails = this.jobMap[channel.identifier+(data?'_sync':'')]
        if (jobDetails) {
            if (jobDetails[1]) {
                logger.warn("Channel " + channel.identifier + " is already running, skip it, tenant: " + this.tenantId)
                return
            }
            jobDetails[1] = true
        } else {
            jobDetails = [null, true]
            this.jobMap[channel.identifier+(data?'_sync':'')] = jobDetails
        }

        if (!data) {
            try {
                const whereExpression: any = { tenantId: this.tenantId, channels: {} }
                whereExpression.channels[channel.identifier] = { status: 1 }
                const result: any = await Item.findAll({
                    attributes: [
                        [fn('count', '*'), 'count']
                    ],
                    where: whereExpression
                })
                const count = result[0].getDataValue('count')
                const handler = this.getHandler(channel)
                if (count > 0) {
                    logger.info("Found " + count + " submitted items for channel " + channel.identifier + ", tenant: " + this.tenantId)
                    if (process.env.OPENPIM_NO_CHANNEL_SCHEDULER === 'false') {
                        // reload channel from DB
                        const tst = await Channel.findByPk(channel.id)
                        if (tst) {
                            channel = tst
                            logger.info("Channel reloaded: " + channel.identifier + ", tenant: " + this.tenantId)
                        }
                    }
                    await handler.processChannel(channel, language, data)
                } else {
                    logger.info("Submitted items are not found for channel " + channel.identifier + ", skiping it, tenant: " + this.tenantId)
                }
            } finally {
                jobDetails[1] = false
            }
        } else {
            try {
                const handler = this.getHandler(channel)
                if (process.env.OPENPIM_NO_CHANNEL_SCHEDULER === 'false') {
                    // reload channel from DB
                    const tst = await Channel.findByPk(channel.id)
                    if (tst) {
                        channel = tst
                        logger.info("Channel reloaded: " + channel.identifier + ", tenant: " + this.tenantId)
                    }
                }
                await handler.processChannel(channel, language, data)
            } finally {
                jobDetails[1] = false
            }
        }
    }

    public startChannel(channel: Channel) {
        if (process.env.OPENPIM_NO_CHANNEL_SCHEDULER === 'true') return
        if (channel.active) {
            this.stopChannel(channel)
            if (!channel.config.start || channel.config.start === 1) {
                this.jobMap[channel.identifier] = [null, false]
            } else if (channel.config.start === 2) { //interval
                if(channel.config.interval) {
                    const range = new Range(0, 60, parseInt(channel.config.interval))
                    const job = scheduleJob({minute: range}, () => {
                        this.triggerChannel(channel, channel.config.language, null)
                    })  
                    this.jobMap[channel.identifier] = [job, false]
                } else {
                    logger.warn('Interval is not set for channel: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            } else if (channel.config.start === 4) { //cron
                if(channel.config.cron) {
                    const job = scheduleJob(channel.config.cron, () => {
                        this.triggerChannel(channel, channel.config.language, null)
                    })  
                    this.jobMap[channel.identifier] = [job, false]
                } else {
                    logger.warn('Cron expression is not set for channel: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            } else { // time
                if(channel.config.time) {
                    const arr = channel.config.time.split(':')
                    const job = scheduleJob({hour: parseInt(arr[0]), minute: parseInt(arr[1])}, () => {
                        this.triggerChannel(channel, channel.config.language, null)
                    })  
                    this.jobMap[channel.identifier] = [job, false]
                } else {
                    logger.warn('Time is not set for channel: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            }
            if (!channel.config.syncStart || channel.config.syncStart === 1) {
                this.jobMap[channel.identifier+'_sync'] = [null, false]
            } else if (channel.config.syncStart === 2) { // sync interval
                if(channel.config.syncInterval) {
                    const range = new Range(0, 60, parseInt(channel.config.syncInterval))
                    const job = scheduleJob({minute: range}, () => {
                        this.triggerChannel(channel, channel.config.language, {sync:true})
                    })  
                    this.jobMap[channel.identifier+'_sync'] = [job, false]
                } else {
                    logger.warn('Interval is not set for channel sync: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            } else if (channel.config.start === 4) { //cron
                if(channel.config.syncCron) {
                    const job = scheduleJob(channel.config.syncCron, () => {
                        this.triggerChannel(channel, channel.config.language, {sync:true})
                    })  
                    this.jobMap[channel.identifier+'_sync'] = [job, false]
                } else {
                    logger.warn('Cron expression is not set for channel sync: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            } else { // sync time
                if(channel.config.syncTime) {
                    const arr = channel.config.syncTime.split(':')
                    const job = scheduleJob({hour: parseInt(arr[0]), minute: parseInt(arr[1])}, () => {
                        this.triggerChannel(channel, channel.config.language, {sync:true})
                    })  
                    this.jobMap[channel.identifier+'_sync'] = [job, false]
                } else {
                    logger.warn('Time expression is not set for channel sync: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            }
        }
    }

    private extChannelHandler = new ExtChannelHandler()
    private wbChannelHandler = new WBChannelHandler()
    private wbNewChannelHandler = new WBNewChannelHandler()
    private ozonChannelHandler = new OzonChannelHandler()
    private ymChannelHandler = new YMChannelHandler()
    public getHandler(channel: Channel): ChannelHandler {
        if (channel.type === 1 || channel.type === 5) return this.extChannelHandler
        // if (channel.type === 2) return this.wbChannelHandler
        if (channel.type === 2) return this.wbNewChannelHandler
        if (channel.type === 3) return this.ozonChannelHandler
        if (channel.type === 4) return this.ymChannelHandler
        throw new Error('Failed to find handler for channel type: ' + channel.type)
    }
}

export class ChannelsManagerFactory {
    private static instance: ChannelsManagerFactory = new ChannelsManagerFactory()
    private tenantMap: Record<string, ChannelsManager> = {}
    
    private constructor() { }

    public static getInstance(): ChannelsManagerFactory {
        return ChannelsManagerFactory.instance
    }

    public getChannelsManager(tenant: string): ChannelsManager {
        let tst = this.tenantMap[tenant]
        if (!tst) {
            logger.warn('Can not find channels manager for tenant: ' + tenant);
            tst = new ChannelsManager(tenant)
            this.tenantMap[tenant] = tst
        }
        return tst
    }

    public async init() {
        let where: WhereOptions | undefined = undefined
        if (process.argv.length > 3) {
            where = {tenantId: process.argv.splice(3)}
        }
        await this.initChannels(where)
    }

    public async initChannels(where: WhereOptions | undefined) {
        const channels = await Channel.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!channels) return

        let mng: ChannelsManager | null = null
        for (var i = 0; i < channels.length; i++) {
            const channel = channels[i];
            if (!mng || mng.getTenantId() !== channel.tenantId) {
                mng = new ChannelsManager(channel.tenantId)
                this.tenantMap[channel.tenantId] = mng
            }
            mng.addChannel(channel)
        }
    }
}