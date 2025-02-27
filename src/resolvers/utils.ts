import XRegExp = require("xregexp")
import { ModelManager, ModelsManager } from "../models/manager"
import { Item } from "../models/items"
import { EventType, TriggerType, Action } from "../models/actions"
import {VM, VMScript} from 'vm2'
import Context from "../context"
import { ItemRelation } from "../models/itemRelations"
import { exec } from 'child_process'
const { Op } = require("sequelize");
import { sequelize } from '../models'
import { QueryTypes } from 'sequelize'
import audit, { ChangeType, ItemChanges, ItemRelationChanges } from '../audit'

const util = require('util');
const awaitExec = util.promisify(exec);

import fetch from 'node-fetch'
import { URLSearchParams } from 'url'
import * as mailer from 'nodemailer'
import * as http2 from 'http2'
import * as http from 'http'
import * as https from 'https'
import * as FS from 'node:fs'
import * as fs from 'fs/promises'
import moment from 'moment'
import KafkaJS from "kafkajs"
const archiver = require('archiver')
import * as stream from 'node:stream' 
const pipe = util.promisify(stream.pipeline)
import XLSX from 'xlsx'

import logger from '../logger'
import { LOV } from "../models/lovs"
import { AttrGroup, Attribute } from "../models/attributes"
import dateFormat from "dateformat"
import { FileManager } from "../media/FileManager"

export function filterChannels(context: Context, channels:any) {
    for (const prop in channels) {
        if (!context.canViewChannel(prop)) {
            delete channels[prop]
        }
    }
}

export function filterEditChannels(context: Context, channels:any) {
    if (!channels) return
    for (const prop in channels) {
        if (!context.canEditChannel(prop)) {
            delete channels[prop]
        }
    }
}

export function checkSubmit(context: Context, channels: any) {
    if (channels) {
        for (const prop in channels) {
            if (channels[prop].status === 1) {
                channels[prop].submittedAt = Date.now()
                channels[prop].submittedBy = context.getCurrentUser()?.login
                channels[prop].message = ''
            }
            if (channels[prop].status === 2) {
                channels[prop].syncedAt = Date.now()
            }
        }
    }
}

export function filterValues(allowedAttributes: string[] | null, values:any) {
    if (allowedAttributes) {
        for (const prop in values) {
            if (!allowedAttributes.includes(prop)) {
                delete values[prop]
            }
        }
    }    
}

export function processDeletedChannels(channels:any) {
    if (channels) {
        for (const key in channels) {
            if (channels[key].is_deleted) {
                delete channels[key]
            }
        }
    }
}

export function mergeValues(newValues: any, oldValues: any): any {
    if (newValues) {
        if (oldValues) {
            for (const prop in oldValues) {
                const obj = oldValues[prop]
                const newobj = newValues[prop]
                if (obj !== null && typeof obj === 'object' && typeof newobj === 'object' && !Array.isArray(newobj)) {
                    newValues[prop] = {...oldValues[prop], ...newValues[prop]}
                }
            }
            return {...oldValues, ...newValues}
        } else {
            return newValues
        }
    } else {
        return oldValues
    }
}

/*!
 * Find the differences between two objects and push to a new object
 * @param  {Object} obj1 The original object
 * @param  {Object} obj2 The object to compare against it
 * @return {Object}      An object of differences between the two
 */
export function diff(obj1: any, obj2: any) {
    // Make sure an object to compare is provided
    if (!obj2 || Object.prototype.toString.call(obj2) !== '[object Object]') {
        return obj1;
    }

    //
    // Variables
    //
    var diffs: any = {added:{}, changed: {}, old:{}, deleted: {}};
    var key;

    //
    // Methods
    //
    /**
     * Compare two items and push non-matches to object
     * @param  {*}      item1 The first item
     * @param  {*}      item2 The second item
     * @param  {String} key   The key in our object
     */
    var compare = function (item1: any, item2: any, key: any) {
        // Get the object type
        var type1 = Object.prototype.toString.call(item1);
        var type2 = Object.prototype.toString.call(item2);

        // If type2 is undefined it has been removed
        if (type2 === '[object Undefined]') {
            if (type1 !== '[object Object]') {
                diffs.deleted[key] = item1 !== null ? item1 + "" : null;
                return;
            }
        }

        // If items are different types
        if (type1 !== type2) {
            diffs.changed[key] = item2 !== null ? item2 + "" : null;
            diffs.old[key] = item1 !== null ? item1 + "" : null;
            return;
        }

        // If an object, compare recursively
        if (type1 === '[object Object]') {
            var objDiff = diff(item1, item2);
            if (Object.keys(objDiff).length > 0) {
                if (Object.keys(objDiff.added).length > 0) diffs.added[key] = objDiff.added;
                if (Object.keys(objDiff.changed).length > 0) diffs.changed[key] = objDiff.changed;
                if (Object.keys(objDiff.old).length > 0) diffs.old[key] = objDiff.old;
                if (Object.keys(objDiff.deleted).length > 0) diffs.deleted[key] = objDiff.deleted;
            }
            return;
        }

        if ((!Array.isArray(item1) && item1 !== item2) || (Array.isArray(item1) && !(item1.length === item2.length && item1.every((elem:any) => item2.indexOf(elem) !== -1)))) {
            diffs.changed[key] = item2 !== null ? item2 + "" : null;
            diffs.old[key] = item1 !== null ? item1 + "" : null;
        } 
    };

    //
    // Compare our objects
    //
    // Loop through the first object
    for (key in obj1) {
        if (key in obj1) {
            compare(obj1[key], obj2[key], key);
        }
    }

    // Loop through the second object and find missing items
    for (key in obj2) {
        if (key in obj2) {
            if (!(key in obj1) && obj1[key] !== obj2[key]) {
                diffs.added[key] = obj2[key] !== null ? obj2[key]  : null;
            }
        }
    }

    // Return the object of differences
    return diffs
}

export function isObjectEmpty(obj:any) {
    return Object.keys(obj).length === 0;
}

export function checkValues(mng: ModelManager, values: any) {
    for(const prop in values) {
        const attr = mng.getAttributeByIdentifier(prop)?.attr
        if (attr && attr.pattern) {
            const regex = XRegExp(attr.pattern, 'g')
            if (attr.languageDependent) {
                for(const lang in values[prop]) {
                    const value = values[prop][lang] ? '' + values[prop][lang] : ''
                    if (!regex.test(value)) {
                        let str = 'Wrong value: ' + value + ' for pattern: ' + attr.pattern
                        if (attr.errorMessage) {
                            for (const prop in attr.errorMessage) {
                                if (attr.errorMessage[prop]) {
                                    str = attr.errorMessage[prop]
                                    break
                                }
                            }
                        }
                        throw  new Error(str)
                    }
                }
            } else {
                const value = values[prop] ? '' + values[prop] : ''
                if (!regex.test(value)) {
                    let str = 'Wrong value: ' + value + ' for pattern: ' + attr.pattern
                    if (attr.errorMessage) {
                        for (const prop in attr.errorMessage) {
                            if (attr.errorMessage[prop]) {
                                str = attr.errorMessage[prop]
                                break
                            }
                        }
                    }
                    throw  new Error(str)
                }
            }
        } else if (attr && attr.type === 3) { // Integer
            if (attr.languageDependent) {
                for(const lang in values[prop]) {
                    const value = values[prop][lang]
                    checkInteger(attr, value)
                }
            } else {
                const value = values[prop]
                checkInteger(attr, value)
            }
        }
    }
}

function checkInteger(attr: Attribute, value: any) {
    if (!value) return
    if (typeof value === 'string') {
        if (value.includes('.')) {
            throw new Error(value + ' is not an Integer for attribute with identifier: ' + attr.identifier)
        } else {
            const tst = parseInt(value)
            if (!(/^[-+]?(\d+|Infinity)$/.test(value))) {
                throw new Error(value + ' is not an Integer for attribute with identifier: ' + attr.identifier)
            }
        }
    } else {
        if (!Number.isInteger(value)) {
            throw new Error(value + ' is not an Integer for attribute with identifier: ' + attr.identifier)
        }
    }
}

export async function processItemActions(context: Context, event: EventType, item: Item, newParent: string, newName: string, newValues: any, newChannels:any, isImport: boolean, isFileUpload: boolean) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const pathArr = item.path.split('.').map((elem:string) => parseInt(elem))
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.Item && 
                parseInt(trigger.event) === event && 
                item.typeId === parseInt(trigger.itemType) &&
                pathArr.includes(parseInt(trigger.itemFrom))
            if (result) return true
        }
        return false
    })
    return await processActions(mng, actions, { Op: Op,
        event: EventType[event],
        fileUpload: isFileUpload,
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { fs, exec, awaitExec, fetch, URLSearchParams, mailer, http, https, http2, moment, XLSX, archiver, stream, pipe, FS, KafkaJS },
        isImport: isImport, 
        item: makeItemProxy(item), values: newValues, channels: newChannels, name: newName, parent: newParent,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy),
            Item,
            ItemRelation
        } 
    })
}

export async function processItemButtonActions(context: Context, buttonText: string, item: Item, data: string) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const pathArr = item.path.split('.').map((elem:string) => parseInt(elem))
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.Button && 
                trigger.itemButton === buttonText && 
                item.typeId === parseInt(trigger.itemType) &&
                pathArr.includes(parseInt(trigger.itemFrom))
            if (result) return true
        }
        return false
    })

    return processItemButtonActions2(context, actions, item, data, buttonText)
}

export async function processItemButtonActions2(context: Context, actions: Action[], item: Item, data: string, buttonText: string) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const valuesCopy = {...item.values}
    const channelsCopy = {...item.channels}
    const nameCopy = {...item.name}
    const ret = await processActions(mng, actions, { Op: Op,
        event: 'Button:'+buttonText,
        data: data,
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { fs, exec, awaitExec, fetch, URLSearchParams, mailer, http, https, http2, moment, XLSX, archiver, stream, pipe, FS, KafkaJS },
        buttonText: buttonText, 
        item: makeItemProxy(item), values: valuesCopy, channels:channelsCopy, name: nameCopy,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy),
            Item,
            ItemRelation
        } 
    })
    return {channels:channelsCopy, values:valuesCopy, result: ret[0]}
}

export async function testAction(context: Context, action: Action, item: Item) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const values = {...item.values}
    const channels = {...item.channels}
    let log = ''
    const nameCopy = {...item.name}
    const ret = await processActionsWithLog(mng, [action], { Op: Op,
        event: 'Test', 
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { fs, exec, awaitExec, fetch, URLSearchParams, mailer, http, https, http2, XLSX, FS, pipe, stream, archiver },
        item: makeItemProxy(item), values: values, channels:channels, name: nameCopy,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy),
            Item,
            ItemRelation
        }},
        { 
            log: ((...args: any) => { log += '' + args + '\n'}),
            error: ((...args: any) => { log += '[ERROR] ' + args + '\n'}),
        }
    )
    return { values, log, ...ret[0] }
}

export async function processAttrGroupActions(context: Context, event: EventType, grp: AttrGroup, isImport: boolean) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.AttrGroup && parseInt(trigger.event) === event
            if (result) return true
        }
        return false
    })
    return await processActions(mng, actions, { Op: Op,
        event: EventType[event],
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { fs, exec, awaitExec, fetch, URLSearchParams, mailer, http, https, http2, moment, XLSX, archiver, stream, pipe, FS, KafkaJS },
        isImport: isImport, 
        group: grp,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy),
            Item,
            ItemRelation
        } 
    })
}

export async function processAttributeActions(context: Context, event: EventType, attr: Attribute, isImport: boolean) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.Attribute && parseInt(trigger.event) === event
            if (result) return true
        }
        return false
    })
    return await processActions(mng, actions, { Op: Op,
        event: EventType[event],
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { fs, exec, awaitExec, fetch, URLSearchParams, mailer, http, https, http2, moment, XLSX, archiver, stream, pipe, FS, KafkaJS },
        isImport: isImport, 
        attribute: attr,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy),
            Item,
            ItemRelation
        } 
    })
}


async function processActions(mng: ModelManager, actions: Action[], sandbox: any) {
    const cons = { 
        log: ((...args: any) => {logger.info('ACTION: ' + args)}),
        error: ((...args: any) => {logger.error('ACTION: ' + args)})
    }
    return await processActionsWithLog(mng, actions, sandbox, cons)
}

async function processActionsWithLog(mng: ModelManager, actions: Action[], sandbox: any, console: any): 
    Promise<{identifier: string, compileError?: string, message?: string, error?:string, data?: any, result?: any}[]> {
    const retArr = []
    if (actions.length > 0) {
        const vm = new VM({
            timeout: 3000,
            sandbox: sandbox
        }) 
        vm.setGlobals({console: console})
        actions.sort((a, b) => a.order - b.order)
        for (let i = 0; i < actions.length; i++) {
            const action = actions[i]
            let script:VMScript | {compileError: boolean, error: string} | undefined = mng.getActionsCache()[action.identifier]
            if (script instanceof VMScript || script === undefined) {
                if (script === undefined) {
                    const code = `
                    async () => {
                        ` + action.code + `
                    }
                    `
                    script = new VMScript(code)
                    try {
                        script.compile()
                    } catch (err:any) {
                        retArr.push({identifier: action.identifier, compileError: err.message})
                        logger.error('Failed to compile script.', err);
                        script = {compileError: true, error: err.message}
                    }
                    mng.getActionsCache()[action.identifier] = script
                }
                if (script instanceof VMScript) {
                    const funct = vm.run(<VMScript>script)
                    try {
                        const ret = await funct()
                        if (ret) {
                            if (typeof ret === 'object') {
                                retArr.push({identifier: action.identifier, message: ret.message, error: ret.error, data: ret.data, result: ret.result})
                            } else {
                                retArr.push({identifier: action.identifier, message: ''+ret})
                            }
                        } else {
                            retArr.push({identifier: action.identifier})
                        }
                    } catch (err) {
                        logger.error('Failed to run action: ' + action.identifier);
                        throw err
                    }
                } else {
                    retArr.push({identifier: action.identifier, compileError: script.error})
                }
            } else {
                retArr.push({identifier: action.identifier, compileError: script.error})
            }
        }
    }
    return retArr
}

function makeModelProxy(model: any, itemProxy: any) {
    return new Proxy( model, {
        get: function( target, property, receiver ) {
            if ((<string>property) =='findOne') {
                return async(...args: any) => {
                    const tst = await target[ property ].apply( target, args )
                    return tst? itemProxy(tst) : undefined
                }
            } else if ((<string>property) =='create') {
                return async(...args: any) => {
                    return itemProxy(await target[ property ].apply( target, args ))
                }
            } else if ((<string>property) =='count') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else if ((<string>property) =='findAll') {
                return async(...args: any) => {
                    const arr = await target[ property ].apply( target, args )
                    return arr.map((elem: any) => itemProxy(elem))
                }
            } else {
                return null
            }
        }
    })    
}

function makeItemProxy(item: any) {
    return new Proxy( item, {
        get: function( target, property, receiver ) {
            if ((<string>property) =='save') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='destroy') {
                return async(...args: any) => {
                    target.set('identifier', target.identifier + "_d"+Date.now())
                    target.save()            
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='set') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='changed') {
                return (...args: any) => {
                    return target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='id') { return target[ property ]
            } else  if ((<string>property) =='tenantId') { return target[ property ]
            } else  if ((<string>property) =='identifier') { return target[ property ]
            } else  if ((<string>property) =='path') { return target[ property ]
            } else  if ((<string>property) =='typeId') { return target[ property ]
            } else  if ((<string>property) =='typeIdentifier') { return target[ property ]
            } else  if ((<string>property) =='parentIdentifier') { return target[ property ]
            } else  if ((<string>property) =='name') { return target[ property ]
            } else  if ((<string>property) =='values') { return target[ property ]
            } else  if ((<string>property) =='channels') { return target[ property ]
            } else  if ((<string>property) =='fileOrigName') { return target[ property ]
            } else  if ((<string>property) =='storagePath') { return target[ property ]
            } else  if ((<string>property) =='mimeType') { return target[ property ]
            } else  if ((<string>property) =='createdBy') { return target[ property ]
            } else  if ((<string>property) =='updatedBy') { return target[ property ]
            } else  if ((<string>property) =='createdAt') { return target[ property ]
            } else  if ((<string>property) =='updatedAt') { return target[ property ]
            }
        },
        set: function(target, prop, value, receiver) {
            if (
                prop === 'path' ||
                prop === 'typeId' ||
                prop === 'typeIdentifier' ||
                prop === 'parentIdentifier' ||
                prop === 'name' ||
                prop === 'values' ||
                prop === 'channels' ||
                prop === 'storagePath' ||
                prop === 'fileOrigName' ||
                prop === 'mimeType' ||
                prop === 'updatedBy'
                ) {
                target[prop] = value
                return true
            } else {
                return false
            }
        }
    })    
}
export async function processItemRelationActions(context: Context, event: EventType, itemRelation: ItemRelation, changes:any, newValues: any, isImport: boolean) {
    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const actions = mng.getActions().filter(action => {
        for (let i = 0; i < action.triggers.length; i++) {
            const trigger = action.triggers[i]

            const result = parseInt(trigger.type) === TriggerType.ItemRelation && 
                parseInt(trigger.event) === event && 
                itemRelation.relationId === parseInt(trigger.relation)
            if (result) return true
        }
        return false
    })
    return await processActions(mng, actions, { Op: Op,
        event: EventType[event],
        user: context.getCurrentUser()?.login,
        roles: context.getUser()?.getRoles(),
        utils: new ActionUtils(context),
        system: { fs, exec, awaitExec, fetch, URLSearchParams, mailer, http, https, http2, moment, XLSX, archiver, stream, pipe, FS, KafkaJS },
        isImport: isImport, 
        itemRelation: makeItemRelationProxy(itemRelation), values: newValues, changes: changes,
        models: { 
            item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
            itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
            lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy),
            Item,
            ItemRelation
        } 
    })
}

function makeItemRelationProxy(item: any) {
    return new Proxy( item, {
        get: function( target, property, receiver ) {
            if ((<string>property) =='save') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='destroy') {
                return async(...args: any) => {
                    target.set('identifier', target.identifier + "_d"+Date.now())
                    target.save()            
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='set') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='changed') {
                return (...args: any) => {
                    return target[ property ].apply( target, args )
                }
            } else  if ((<string>property) =='id') { return target[ property ]
            } else  if ((<string>property) =='tenantId') { return target[ property ]
            } else  if ((<string>property) =='identifier') { return target[ property ]
            } else  if ((<string>property) =='relationId') { return target[ property ]
            } else  if ((<string>property) =='relationIdentifier') { return target[ property ]
            } else  if ((<string>property) =='itemId') { return target[ property ]
            } else  if ((<string>property) =='itemIdentifier') { return target[ property ]
            } else  if ((<string>property) =='targetId') { return target[ property ]
            } else  if ((<string>property) =='targetIdentifier') { return target[ property ]
            } else  if ((<string>property) =='values') { return target[ property ]
            } else  if ((<string>property) =='createdBy') { return target[ property ]
            } else  if ((<string>property) =='updatedBy') { return target[ property ]
            } else  if ((<string>property) =='createdAt') { return target[ property ]
            } else  if ((<string>property) =='updatedAt') { return target[ property ]
            }
        },
        set: function(target, prop, value, receiver) {
            if (
                prop === 'relationId' ||
                prop === 'relationIdentifier' ||
                prop === 'itemId' ||
                prop === 'itemIdentifier' ||
                prop === 'targetId' ||
                prop === 'targetIdentifier' ||
                prop === 'values' ||
                prop === 'updatedBy'
                ) {
                target[prop] = value
                return true
            } else {
                return false
            }
        }
    })
}

function makeLOVProxy(item: any) {
    return new Proxy(item, {
        get: function (target, property, receiver) {
            if ((<string>property) == 'save') {
                return async (...args: any) => {
                    return await target[property].apply(target, args)
                }
            } else if ((<string>property) == 'destroy') {
                return async (...args: any) => {
                    target.set('identifier', target.identifier + "_d" + Date.now())
                    target.save()
                    return await target[property].apply(target, args)
                }
            } else if ((<string>property) == 'set') {
                return async (...args: any) => {
                    return await target[property].apply(target, args)
                }
            } else  if ((<string>property) =='changed') {
                return async(...args: any) => {
                    return await target[ property ].apply( target, args )
                }
            } else if ((<string>property) == 'id') {
                return target[property]
            } else if ((<string>property) == 'tenantId') {
                return target[property]
            } else if ((<string>property) == 'identifier') {
                return target[property]
            } else if ((<string>property) == 'name') {
                return target[property]
            } else if ((<string>property) == 'values') {
                return target[property]
            } else if ((<string>property) == 'createdBy') {
                return target[property]
            } else if ((<string>property) == 'updatedBy') {
                return target[property]
            } else if ((<string>property) == 'createdAt') {
                return target[property]
            } else if ((<string>property) == 'updatedAt') {
                return target[property]
            }
        },
        set: function (target, prop, value, receiver) {
            if (
                prop === 'name' ||
                prop === 'values' ||
                prop === 'updatedBy'
            ) {
                target[prop] = value
                return true
            } else {
                return false
            }
        }
    })
}

class ActionUtils {
    #context: Context // hard private field to avoid access to it from action (to avoid ability to change tennantId)
    #mng: ModelManager

    public constructor(context: Context) {
        this.#context = context 
        this.#mng = ModelsManager.getInstance().getModelManager(this.#context.getCurrentUser()!.tenantId)
    }

    public getCache() { return this.#mng.getCache() }

    public getAttrGroups() {
        // TODO maybe we need to return copy of the data to avoid changing?
        return this.#mng.getAttrGroups()
    }

    public getUserByLogin(login: string) {
        const userWrapper = this.#mng.getUsers().find(user => user.getUser().login === login)
        return userWrapper ? userWrapper.getUser() : null
    }


    public getTypeByIdentifier(typeIdent: string) {
        const typeNode = this.#mng.getTypeByIdentifier(typeIdent)
        return typeNode ? typeNode.getValue() : null
    }

    public getRelations() {
        // TODO maybe we need to return copy of the data to avoid changing?
        return this.#mng.getRelations()
    }

    public getItemAttributes(item: Item, groupIdentifier?: string) {
        return this.getItemAttributesForGroups(item, groupIdentifier ? [groupIdentifier]: undefined)
    }

    public getItemAttributesForGroups(item: Item, groupIdentifiers?: string[]) {
        const arr = this.getItemAttributesObjectForGroups(item, groupIdentifiers)
        return arr.map(elem => elem.identifier)
    }

    public getItemAttributesObject(item: Item, groupIdentifier?: string) {
        return this.getItemAttributesObjectForGroups(item, groupIdentifier ? [groupIdentifier]: undefined)
    }
    
    public getItemAttributesObjectForGroups(item: Item, groupIdentifiers?: string[]) {
        const attrArr: Attribute[] = []
        const pathArr: number[] = item.path.split('.').map(elem => parseInt(elem))

        this.#mng.getAttrGroups().forEach(group => {
            if (group.getGroup().visible && (!groupIdentifiers || groupIdentifiers.includes(group.getGroup().identifier))) {
                group.getAttributes().forEach(attr => {
                    if (attr.valid.includes(item.typeId)) {
                        for (let i=0; i<attr.visible.length; i++ ) {
                            const visible: number = attr.visible[i]
                            if (pathArr.includes(visible)) {
                                if (!attrArr.find(tst => tst.identifier === attr.identifier)) attrArr.push(attr)
                                break
                            }
                        }
                    }
                })
            }
        })
        return attrArr
    }

    public getRelationAttributes(rel: ItemRelation, groupIdentifier?: string) {
        const attrArr: string[] = []

        this.#mng.getAttrGroups().forEach(group => {
            if (group.getGroup().visible && (!groupIdentifier || group.getGroup().identifier === groupIdentifier)) {
                group.getAttributes().forEach(attr => {
                    if (attr.relations.includes(rel.relationId)) {
                        if (!attrArr.find(tst => tst === attr.identifier)) attrArr.push(attr.identifier)
                    }
                })
            }
        })
        return attrArr
    }

    public formatDate(date: Date, format: string) {
        return dateFormat(date, format)
    }

    private a:any = {"(": "_", ")": "_", "\"":"_","'":"_"," ": "_","Ё":"YO","Й":"I","Ц":"TS","У":"U","К":"K","Е":"E","Н":"N","Г":"G","Ш":"SH","Щ":"SCH","З":"Z","Х":"H","Ъ":"'","ё":"yo","й":"i","ц":"ts","у":"u","к":"k","е":"e","н":"n","г":"g","ш":"sh","щ":"sch","з":"z","х":"h","ъ":"'","Ф":"F","Ы":"I","В":"V","А":"a","П":"P","Р":"R","О":"O","Л":"L","Д":"D","Ж":"ZH","Э":"E","ф":"f","ы":"i","в":"v","а":"a","п":"p","р":"r","о":"o","л":"l","д":"d","ж":"zh","э":"e","Я":"Ya","Ч":"CH","С":"S","М":"M","И":"I","Т":"T","Ь":"'","Б":"B","Ю":"YU","я":"ya","ч":"ch","с":"s","м":"m","и":"i","т":"t","ь":"_","б":"b","ю":"yu"};
    public transliterate (word: string) {
      return word.split('').map( (char) => { 
        return this.a[char] || char; 
      }).join("")
    }
  
    public runAs(login: string) {
        const ctx = Context.createAs(login, this.#context.getCurrentUser()!.tenantId)
        this.#context = ctx
    }

    public async saveFile(item: Item, filepath: string, mimetype: string | null, originalFilename: string | null, clean = false) {
        const fm = FileManager.getInstance()
        var stats = FS.statSync(filepath)
        await fm.saveFile(this.#context.getCurrentUser()!.tenantId, item, filepath, mimetype, originalFilename, stats.size, clean)
        item.fileOrigName = originalFilename || ''
        item.mimeType = mimetype || ''
    }

    public getStoragePath(item: Item) {
        return !item.storagePath ? null : FileManager.getInstance().getFilesRoot() + item.storagePath
    }

    public async processItemAction(actionIdentifier: string, event: string, item: Item, newParent: string, newName: string, newValues: any, newChannels:any, isImport: boolean) {
        const mng = ModelsManager.getInstance().getModelManager(this.#context.getCurrentUser()!.tenantId)

        let action  = mng.getActions().find(act => act.identifier === actionIdentifier)
        if (!action) {
            throw new Error('Failed to find action by identifier: ' + actionIdentifier + ', tenant: ' + mng.getTenantId())
        }

        const context = this.#context
        return await processActions(mng, [action], { Op: Op,
            event: event,
            user: context.getCurrentUser()?.login,
            roles: context.getUser()?.getRoles(),
            utils: new ActionUtils(context),
            system: { fs, exec, awaitExec, fetch, URLSearchParams, mailer, http, https, http2, moment, XLSX, archiver, stream, pipe, FS, KafkaJS },
            isImport: isImport, 
            item: makeItemProxy(item), values: newValues, channels: newChannels, name: newName, parent: newParent,
            models: { 
                item: makeModelProxy(Item.applyScope(context), makeItemProxy),  
                itemRelation: makeModelProxy(ItemRelation.applyScope(context), makeItemRelationProxy),  
                lov: makeModelProxy(LOV.applyScope(context), makeLOVProxy),
                Item,
                ItemRelation
            } 
        })
    }

    public async createItem(parentIdentifier: string, typeIdentifier: string, identifier: string, name: any, values: any, skipActions = false) {
        if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)

        const tst = await Item.applyScope(this.#context).findOne({
            where: {
                identifier: identifier
            }
        })
        if (tst) {
            throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const mng = ModelsManager.getInstance().getModelManager(this.#context.getCurrentUser()!.tenantId)
        const type = mng.getTypeByIdentifier(typeIdentifier)
        if (!type) {
            throw new Error('Failed to find type by identifier: ' + typeIdentifier + ', tenant: ' + mng.getTenantId())
        }
        const nTypeId = type.getValue()!.id;

        const results:any = await sequelize.query("SELECT nextval('items_id_seq')", { 
            type: QueryTypes.SELECT
        });
        const id = (results[0]).nextval
        
        let path:string
        if (parentIdentifier) {
            const parentItem = await Item.applyScope(this.#context).findOne({
                where: {
                    identifier: parentIdentifier
                }
            })
            if (!parentItem) {
                throw new Error('Failed to find parent item by identifier: ' + parentIdentifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
            }

            const parentType = mng.getTypeById(parentItem.typeId)!
            const tstType = parentType.getChildren().find(elem => (elem.getValue().id === nTypeId) || (elem.getValue().link === nTypeId))
            if (!tstType) {
                throw new Error('Failed to create item with type: ' + nTypeId + ' under type: ' + parentItem.typeId + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
            }

            parentIdentifier = parentItem.identifier
            path = parentItem.path + "." + id
        } else {
            const tstType = mng.getRoot().getChildren().find(elem => elem.getValue().id === nTypeId)
            if (!tstType) {
                throw new Error('Failed to create root item with type: ' + nTypeId + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
            }

            parentIdentifier = ''
            path = '' + id
        }

        if (!this.#context.canEditItem2(nTypeId, path)) {
            throw new Error('User :' + this.#context.getCurrentUser()?.login + ' can not create such item , tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const item = Item.build ({
            id: id,
            path: path,
            identifier: identifier,
            tenantId: this.#context.getCurrentUser()!.tenantId,
            createdBy: this.#context.getCurrentUser()!.login,
            updatedBy: this.#context.getCurrentUser()!.login,
            name: name,
            typeId: nTypeId,
            typeIdentifier: type.getValue().identifier,
            parentIdentifier: parentIdentifier, 
            values: null,
            fileOrigName: '',
            storagePath: '',
            mimeType: ''
        })

        if (!values) values = {}

        if (!skipActions) await processItemActions(this.#context, EventType.BeforeCreate, item, parentIdentifier, name, values, {}, false, false)

        filterValues(this.#context.getEditItemAttributes2(nTypeId, path), values)
        checkValues(mng, values)

        item.values = values

        await sequelize.transaction(async (t) => {
            await item.save({transaction: t})
        })

        if (!skipActions) await processItemActions(this.#context, EventType.AfterCreate, item, parentIdentifier, name, values, {}, false, false)

        if (audit.auditEnabled()) {
            const itemChanges: ItemChanges = {
                typeIdentifier: item.typeIdentifier,
                parentIdentifier: item.parentIdentifier,
                name: item.name,
                values: values
            }
            audit.auditItem(ChangeType.CREATE, item.id, item.identifier, {added: itemChanges}, this.#context.getCurrentUser()!.login, item.createdAt)
        }

        return makeItemProxy(item)
    }

    public async createItemRelation(relationIdentifier: string, identifier: string, itemIdentifier: string, targetIdentifier: string, values: any, skipActions = false) {
        if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)

        const mng = ModelsManager.getInstance().getModelManager(this.#context.getCurrentUser()!.tenantId)
        const rel = mng.getRelationByIdentifier(relationIdentifier)
        if (!rel) {
            throw new Error('Failed to find relation by identifier: ' + relationIdentifier + ', tenant: ' + mng.getTenantId())
        }

        if (!this.#context.canEditItemRelation(rel.id)) {
            throw new Error('User :' + this.#context.getCurrentUser()?.login + ' can not edit item relation:' + rel.identifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const tst = await ItemRelation.applyScope(this.#context).findOne({
            where: {
                identifier: identifier
            }
        })
        if (tst) {
            throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const item = await Item.applyScope(this.#context).findOne({where: {identifier: itemIdentifier}})
        if (!item) {
            throw new Error('Failed to find item by id: ' + itemIdentifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const targetItem = await Item.applyScope(this.#context).findOne({where: {identifier: targetIdentifier}})
        if (!targetItem) {
            throw new Error('Failed to find target item by id: ' + targetIdentifier + ', tenant: ' + this.#context.getCurrentUser()!.tenantId)
        }

        const tst3 = rel.targets.find((typeId: number) => typeId === targetItem.typeId)
        if (!tst3) {
            throw new Error('Relation with id: ' + relationIdentifier + ' can not have target with type: ' + targetItem.typeId + ', tenant: ' + mng.getTenantId())
        }

        if (!rel.multi) {
            const count = await ItemRelation.applyScope(this.#context).count( {
                where: {
                    itemIdentifier: itemIdentifier,
                    relationId: rel.id
                }
            })

            if (count > 0) {
                throw new Error('Relation with id: ' + itemIdentifier + ' can not have more then one target, tenant: ' + mng.getTenantId())
            }
        }

        const itemRelation = await ItemRelation.build ({
            identifier: identifier,
            tenantId: this.#context.getCurrentUser()!.tenantId,
            createdBy: this.#context.getCurrentUser()!.login,
            updatedBy: this.#context.getCurrentUser()!.login,
            relationId: rel.id,
            relationIdentifier: rel.identifier,
            itemId: item.id,
            itemIdentifier: item.identifier,
            targetId: targetItem.id,
            targetIdentifier: targetItem.identifier,
            values: null
        })

        if (!values) values = {}
        if (!skipActions) await processItemRelationActions(this.#context, EventType.BeforeCreate, itemRelation, null, values, false)

        filterValues(this.#context.getEditItemRelationAttributes(rel.id), values)
        checkValues(mng, values)

        itemRelation.values = values

        await sequelize.transaction(async (t) => {
            await itemRelation.save({transaction: t})
        })

        if (!skipActions) await processItemRelationActions(this.#context, EventType.AfterCreate, itemRelation, null, values, false)

        if (audit.auditEnabled()) {
            const itemRelationChanges: ItemRelationChanges = {
                relationIdentifier: itemRelation.relationIdentifier,
                itemIdentifier: itemRelation.itemIdentifier,
                targetIdentifier: itemRelation.targetIdentifier,
                values: values
            }
            audit.auditItemRelation(ChangeType.CREATE, itemRelation.id, itemRelation.identifier, {added: itemRelationChanges}, this.#context.getCurrentUser()!.login, itemRelation.createdAt)
        }

        return makeItemRelationProxy(itemRelation)
    }    

}