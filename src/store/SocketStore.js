/**
 * <plusmancn@gmail.com> created at 2017
 *
 * Copyright (c) 2017 plusmancn, all rights
 * reserved.
 *
 * @flow
 *
 * Socket 管理，消息中继站
 */
import { observable, computed, toJS } from 'mobx';
import config from '../config.js';
import io from 'socket.io-client';
import _ from 'lodash';

const moment = require('moment');
require('moment/locale/zh-cn');
moment.locale('zh-cn');

import {
    Platform,
    AppState,
    AsyncStorage
} from 'react-native';

export default class SocketStore {
    // 监听对象
    @observable socketId = null;
    @observable currentChatKey = null;
    sessionListMap = observable.map();
    messageHistoryMap = observable.map();
    // 非监听对象
    socket: Object;
    // 哪些会话的聊天记录已经从缓存中恢复过
    _messageHistoryHasResotred = new Set();

    constructor() {
        // App 状态监控
        AppState.addEventListener('change', this._handleAppStateChange);

        // 从缓存恢复消息列表
        this._restoreDataFromLocalStore();

        // 强制指定使用 websocket 作为传输通道
        this.socket = io(config.server, {
            transports: ['websocket']
        });

        this.socket.on('connect', () => {
            this.socketId = this.socket.id;
            this.socket.emit('connect:success', {});
        });

        this.socket.on('message' , (payload) => {
            let sessionItem = this._formatPayloadToSessionItem(payload);
            this.sessionListMap.set(String(sessionItem.key), sessionItem);
            this._pushPayloadToMessageHistory(payload);
        });
    }

    // 本地 payload 推入
    pushLocalePayload(payload: Object) {
        let sessionItem = this._formatPayloadToSessionItem(payload);
        this.sessionListMap.set(String(sessionItem.key), sessionItem);
        this._pushPayloadToMessageHistory(payload);
    }

    clearUnReadMessageCount(key: String) {
        let sessionItem = this.sessionListMap.get(key);
        if (sessionItem) {
            sessionItem = Object.assign({
            }, sessionItem, {
                unReadMessageCount: 0
            });
            this.sessionListMap.set(key, sessionItem);
        }
    }

    // 会话记录
    @computed get sessionList(): Array<Object> {
        return [...this.sessionListMap.values()].sort(function(a, b) {
            return b.timestamp - a.timestamp;
        }).map(function (item) {
            item.latestTime = moment(item.timestamp).startOf('minute').fromNow();
            return item;
        });
    }

    @computed get unReadMessageCountTotal(): number {
        let unReadMessageCountTotal = 0;
        [...this.sessionListMap.values()].forEach(function (item) {
            unReadMessageCountTotal += item.unReadMessageCount;
        });
        return unReadMessageCountTotal;
    }

    @computed get currentChatRoomHistory(): Array<Object> {
        if (this.currentChatKey) {
            // 异步更新
            if (!this._messageHistoryHasResotred.has(this.currentChatKey)) {
                this._restoreMessageFromLocalStore(this.currentChatKey);
                this._messageHistoryHasResotred.add(this.currentChatKey);
            }

            if (this.messageHistoryMap.has(this.currentChatKey)) {
                return this.messageHistoryMap.get(this.currentChatKey);
            } else {
                this.messageHistoryMap.set(this.currentChatKey, []);
                return this.messageHistoryMap.get(this.currentChatKey);
            }
        } else {
            return [];
        }
    }

    _pushPayloadToMessageHistory(payload) {
        let key = this._getPayloadKey(payload);
        payload = _.omit(payload, ['localeExt']);
        if (this.messageHistoryMap.has(key)) {
            this.messageHistoryMap.get(key).push(payload);
        } else {
            this.messageHistoryMap.set(key, [payload]);
        }

        this._saveMessageToLocalStore(key, payload);
    }

    // 格式化会话信息
    _formatPayloadToSessionItem (payload) {
        let sessionItem, key = this._getPayloadKey(payload);
        let preSessionItem = this.sessionListMap.get(key);
        if (payload.localeExt) {
            let toInfo = payload.localeExt.toInfo;
            sessionItem = {
                avatar: toInfo.avatar,
                name: toInfo.name,
                latestMessage: payload.msg.content,
                unReadMessageCount: 0,
                timestamp: +(new Date()),
                key: key,
                toInfo: toInfo
            };
        } else {
            let ext = payload.ext;
            sessionItem = {
                avatar: ext.avatar,
                name: ext.name,
                latestMessage: payload.msg.content,
                timestamp: ext.timestamp,
                unReadMessageCount: preSessionItem ? preSessionItem.unReadMessageCount + 1 : 1,
                key: key,
                toInfo: {
                    userId: payload.from,
                    avatar: ext.avatar,
                    name: ext.name
                }
            };
        }

        return sessionItem;
    }


    _getPayloadKey (payload) {
        if (payload.localeExt) {
            return `${payload.from}-${payload.to}`;
        } else {
            return `${payload.to}-${payload.from}`;
        }
    }


    _handleAppStateChange = (appState) => {
        if (Platform.OS === 'ios' && appState === 'inactive' ) {
            this._saveDataToLocalStore();
        }

        if (Platform.OS === 'android' && appState === 'background') {
            this._saveDataToLocalStore();
        }
    }

    /**
     * 历史消息存储结构
     * message:history:${key} 存储用户的消息 id 集合
     * message:item:${uuid} 消息 uuid 集合
     */
    _saveMessageToLocalStore = async (key, payload) => {
        let historyKey = `message:history:${key}`;
        let history = await AsyncStorage.getItem(historyKey);
        await AsyncStorage.setItem(historyKey, `${history ? history + ',' : '' }${payload.uuid}`);
        await AsyncStorage.setItem(`message:item:${payload.uuid}`, JSON.stringify(payload));
    }

    /**
     * 从历史恢复消息
     * 每次取的数目还不能超过 13 条，不然由于 listView 懒加载，无法滚动到底部
     */
    _restoreMessageFromLocalStore = async (key) => {
        let history = await AsyncStorage.getItem(`message:history:${key}`);
        if (history) {
            let historyUUIDs = history.split(',').slice(-13).map( uuid => `message:item:${uuid}`);
            let messageArray = await AsyncStorage.multiGet(historyUUIDs);

            this.messageHistoryMap.set(key, messageArray.map(item => {
                return JSON.parse(item[1]);
            }));
        }
    }

    /**
     * Session 存储结构如下
     * session:list:map:keys 存放 map key 值列表
     * session:list:key 存储最新一条消息信息
     */
    _saveDataToLocalStore = async () => {
        // 处理 sessionListMap
        AsyncStorage.setItem('session:list:map:keys', [...this.sessionListMap.keys()].join(','));
        for (let [key, value] of this.sessionListMap.entries()) {
            AsyncStorage.setItem(`session:list:${key}`, JSON.stringify(toJS(value)));
        }
    }

    _restoreDataFromLocalStore = async () => {
        // 恢复 sessionListMap
        let keys = await AsyncStorage.getItem('session:list:map:keys');
        if (keys) {
            let initArray = [];
            for (let key of keys.split(',')) {
                let value = JSON.parse((await AsyncStorage.getItem(`session:list:${key}`)));
                initArray.push([key, value]);
            }
            this.sessionListMap.merge(initArray);
        }
    }
}