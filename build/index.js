import React, { Component } from "react";
import { Image, ImageBackground, Platform } from "react-native";
import fs from "react-native-fs";
const SHA1 = require("crypto-js/sha1");
const isObject = (val) => ((val != null) && (typeof val === 'object') && (Array.isArray(val) === false));
const isCachedImageURISource = (val) => (isObject(val) && (typeof val.uri === 'string'));
const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
const BASE_DIR = fs.CachesDirectoryPath + "/react-native-img-cache";
// 下載中的暫存檔一律放在這個子目錄，不跟正式快取檔混在 BASE_DIR 裡。
//
// 原因：快取檔只增不減（不做任何淘汰），久用的使用者 BASE_DIR 會有好幾萬個檔，
// 而 fs.readDir() 在 iOS 要對每個檔案各做一次 attributesOfItemAtPath，實測 3.7 萬檔約 6.4 秒，
// 更糟的是 react-native-fs 的 iOS 端所有呼叫共用同一條串列佇列，readDir 跑完之前
// 其他所有 RNFS 呼叫（InitScreen 的 mkdir、每張圖的 exists／downloadFile）全部排在後面，
// App 就卡在啟動畫面。開機要清暫存檔只能掃這個永遠很小的子目錄，
// 絕對不可以再對 BASE_DIR 做 readDir（或任何會隨快取檔數量變慢的目錄走訪）。
//
// 子目錄名稱 "tmp" 不會跟快取檔撞名：快取檔名是 SHA1 或 UUID 樣式再加副檔名。
const TMP_DIR = BASE_DIR + "/tmp";
const FILE_PREFIX = Platform.OS === "ios" ? "" : "file://";
const TMP_SUFFIX = ".tmp";
// 本次啟動（這個模組實例）的識別碼，每個暫存檔名都以它開頭。開機清理只刪「不是本次前綴」的檔案，
// 見 removeStaleTempFiles()。
const SESSION_ID = s4() + s4() + s4();
// 同一個 session 內的流水號，保證每次下載的暫存檔名都不一樣，見 download()。
let tmpSeq = 0;
// 這些預設值可以被 config 覆寫，見 setOptions()。
// config 裡沒有指定的項目就沿用這裡的值。
const DEFAULT_OPTIONS = {
    // 一般（清單批次）同時下載數上限。
    // Android 的 react-native-fs 每呼叫一次 downloadFile() 就直接 new 一條原生 thread，
    // 完全沒有節流；一個三欄的使用者清單一進畫面就掛上五十幾個 CachedImage，
    // 等於五十幾條連線同時打向同一台主機，在模擬器或弱網下必然大量觸發連線逾時。
    maxConcurrentDownload: 6,
    // 標成 priority 的請求（cacheUri(uri, true)）可用的上限。比上面多出來的部分是
    // 保留給「使用者正在等」的單張圖的（in-app 通知的音效與震動都卡在它後面），
    // 清單那種每一格都會發一次的批次請求永遠碰不到，否則保留名額會被自己吃光。
    maxConcurrentPriorityDownload: 8,
    // 建立連線的絕對期限。react-native-fs 的預設值是 5000，在高併發下會大量誤殺。
    connectionTimeout: 6000,
    // 「多久沒收到任何資料」的閒置逾時，每收到一次資料就重新計時。
    // react-native-fs 的預設值是 15000。
    readTimeout: 15000,
    // 整筆傳輸的總時限。readTimeout 是閒置計時，只要對方持續涓滴就永遠不會觸發，
    // 那條連線會一直佔著併發名額（Android 端沒有任何總時限，iOS 是一小時），
    // 所以需要這一道。設 0 表示不設總時限。
    //
    // 這個值只用來抓「一直涓滴、永遠不結束」的連線，完全沒反應的連線 readTimeout
    // 就會處理掉了，所以它只要明顯長過任何正常傳輸即可。實測滿版照片是 130-200 KB，
    // 30 秒等於要求 6.8 KB/s，弱網下會把還在正常傳輸的照片砍掉而永遠載不出來
    // （實測 edge 節流下同一張被砍三次、ImageCache 整個放棄）。
    totalTimeout: 120000,
    // 下載失敗後 ImageCache 自己重試幾次（不含第一次）。
    maxRetryCount: 2,
    // 第 n 次重試等 retryDelay * n。
    retryDelay: 1000,
    // 連 ImageCache 的重試都用完之後，元件自己再排程重試幾次，
    // 才不會因為一段短暫的斷網就讓畫面永遠停在空白。
    componentMaxRetry: 1,
    // 第 n 次等 componentRetryDelay * n。
    componentRetryDelay: 6000,
};
// 每一項可接受的最小值。config 有可能是伺服器推下來的，超出範圍的值一律忽略。
const OPTION_MIN = {
    maxConcurrentDownload: 1,
    maxConcurrentPriorityDownload: 1,
    connectionTimeout: 1,
    readTimeout: 1,
    totalTimeout: 0,
    maxRetryCount: 0,
    retryDelay: 0,
    componentMaxRetry: 0,
    componentRetryDelay: 0,
};
const options = Object.assign({}, DEFAULT_OPTIONS);
export class ImageCache {
    getPath(uri, immutable) {
        const mappedUri = this.uriMapper ? this.uriMapper(uri) : uri;
        let path = mappedUri.substring(mappedUri.lastIndexOf("/"));
        path = path.indexOf("?") === -1 ? path : path.substring(path.lastIndexOf("."), path.indexOf("?"));
        const ext = path.indexOf(".") === -1 ? ".jpg" : path.substring(path.indexOf("."));
        if (immutable === true) {
            return BASE_DIR + "/" + SHA1(mappedUri) + ext;
        }
        else {
            return BASE_DIR + "/" + s4() + s4() + "-" + s4() + "-" + s4() + "-" + s4() + "-" + s4() + s4() + s4() + ext;
        }
    }
    constructor() {
        this.cache = {};
        this.pendingQueue = [];
        this.activeDownloadCount = 0;
        // need to create the dir for cache files. if it does not exist, fs.downloadFile() will fail.
        // 建 TMP_DIR 會連 BASE_DIR 一起建好（react-native-fs 的 mkdir 在 iOS 是
        // createDirectoryAtPath:withIntermediateDirectories:YES、Android 是 File.mkdirs()），
        // 所以不必另外 mkdir(BASE_DIR)；目錄已存在時兩個平台都是成功。
        fs.mkdir(TMP_DIR)
            .then(() => this.removeStaleTempFiles())
            .catch(() => undefined);
    }
    static get() {
        if (!ImageCache.instance) {
            ImageCache.instance = new ImageCache();
        }
        return ImageCache.instance;
    }
    // config 裡有指定的項目會蓋掉預設值，沒指定（或值不合法）的一律回到預設值，
    // 所以重複呼叫是冪等的 —— configOverride() 每次推新的設定下來都可以直接再呼叫一次。
    setOptions(p_oOptions) {
        Object.keys(DEFAULT_OPTIONS).forEach((sKey) => {
            const xValue = isObject(p_oOptions) ? p_oOptions[sKey] : undefined;
            const bValid = (typeof xValue === "number") && isFinite(xValue) && (xValue >= OPTION_MIN[sKey]);
            options[sKey] = bValid ? xValue : DEFAULT_OPTIONS[sKey];
        });
        // 優先請求的上限不能比一般的低，否則保留名額會變成負的。
        if (options.maxConcurrentPriorityDownload < options.maxConcurrentDownload) {
            options.maxConcurrentPriorityDownload = options.maxConcurrentDownload;
        }
        // 上限有可能被調大了，把等待中的補上去。
        this.pump();
    }
    setUriMapper(p_fUriMapper) {
        this.uriMapper = p_fUriMapper;
    }
    clearUriMapper() {
        this.uriMapper = undefined;
    }
    // p_bPriority 只給「使用者正在等這一張圖、而且同一時間不會有很多張」的呼叫端用，
    // 例如 in-app 通知的頭像。清單上每一格都會呼叫一次的那種批次請求要維持預設值。
    cacheUri(uri, p_bPriority) {
        const source = { uri };
        return new Promise((resolve) => {
            // 成功時把快取檔路徑交出去。呼叫端若需要路徑就不必再 on() 一次 ——
            // 那種只掛 handler 而沒有 errorHandler 的訂閱，在下載放棄時會被靜靜丟掉，
            // 呼叫端的 Promise 也就永遠不會結束。
            const handler = (path) => {
                this.dispose(uri, handler, errorHandler);
                resolve(path);
            };
            // 失敗時也一定要把這個 promise 結束掉。原本只在成功時 resolve，
            // 一旦下載失敗呼叫端的 await 就永遠回不來（in-app 通知整個不出現就是這樣來的）。
            const errorHandler = () => {
                this.dispose(uri, handler, errorHandler);
                resolve(undefined);
            };
            this.on(source, handler, true, errorHandler, p_bPriority === true);
        });
    }
    clear() {
        this.cache = {};
        this.pendingQueue = [];
        // 砍掉整個目錄之後一定要補回來，否則之後每一次 downloadFile() 都會失敗。
        // 暫存檔的子目錄也一起補（mkdir 會連 BASE_DIR 一起建）。
        return fs.unlink(BASE_DIR).then(() => fs.mkdir(TMP_DIR));
    }
    on(source, handler, immutable, errorHandler, priority) {
        const { uri } = source;
        if (!this.cache[uri]) {
            this.cache[uri] = {
                source,
                handlers: [handler],
                errorHandlers: errorHandler ? [errorHandler] : [],
                immutable: immutable === true,
                path: immutable === true ? this.getPath(uri, immutable) : undefined,
                downloading: false,
                retryCount: 0,
                priority: priority === true
            };
        }
        else {
            this.cache[uri].handlers.push(handler);
            if (errorHandler) {
                this.cache[uri].errorHandlers.push(errorHandler);
            }
            if (priority === true) {
                this.promote(uri);
            }
        }
        this.get(uri);
    }
    dispose(uri, handler, errorHandler) {
        const cache = this.cache[uri];
        if (cache) {
            // 原本是在 forEach 裡面 splice，索引會位移而跳過下一個 handler，
            // 造成明明下載成功卻有元件收不到通知、畫面一直空白。
            cache.handlers = cache.handlers.filter(h => h !== handler);
            if (errorHandler) {
                cache.errorHandlers = cache.errorHandlers.filter(h => h !== errorHandler);
            }
        }
    }
    bust(uri) {
        const cache = this.cache[uri];
        if (cache !== undefined && !cache.immutable) {
            cache.path = undefined;
            this.get(uri);
        }
    }
    cancel(uri) {
        const cache = this.cache[uri];
        if (cache && cache.task) {
            fs.stopDownload(cache.task.jobId);
        }
    }
    download(cache) {
        const { source } = cache;
        const { uri } = source;
        if (cache.downloading) {
            return;
        }
        const path = this.getPath(uri, cache.immutable);
        // 先寫到暫存檔、成功後才 rename 到正式路徑。process 被殺掉時才不會在正式路徑上
        // 留下半截檔案；那種檔案之後 fs.exists() 是 true，會被當成快取命中而永遠解不出圖。
        //
        // 暫存檔名必須每次下載都不一樣：uriMapper 會把不同主機的 URL 正規化成同一個
        // 快取路徑（例如 apiprod2/apiprod3 都對到 apiprod），那是兩個不同的 cache entry
        // 卻共用同一個 path。若暫存檔名固定，兩邊會同時寫同一個檔，先完成的 rename 之後
        // 另一邊的 fd 仍指著同一個 inode 繼續寫，正式快取檔就被寫壞了。
        //
        // 檔名不必（也不再）由 path 衍生：暫存檔放在 TMP_DIR，和正式路徑在同一個磁碟區，
        // 所以下面的 moveFile 仍是 rename，成本可忽略。名稱是「本次啟動的 SESSION_ID + 流水號」，
        // 流水號保證同一個 session 內絕不重複，SESSION_ID 讓開機清理認得出哪些是這次的。
        tmpSeq++;
        const tmpPath = TMP_DIR + "/" + SESSION_ID + "-" + tmpSeq + TMP_SUFFIX;
        cache.downloading = true;
        this.activeDownloadCount++;
        let settled = false;
        let oTotalTimer = undefined;
        const done = () => {
            // 只能生效一次。activeDownloadCount 一旦被多扣，pump() 的併發上限就整個失效，
            // 會退回原本幾十條連線同時打的行為。
            if (settled) {
                return;
            }
            settled = true;
            if (oTotalTimer !== undefined) {
                clearTimeout(oTotalTimer);
                oTotalTimer = undefined;
            }
            cache.downloading = false;
            cache.task = null;
            this.activeDownloadCount--;
            this.pump();
        };
        const fail = (err) => {
            if (settled) {
                return;
            }
            // Parts of the image may have been downloaded already, (see https://github.com/wkh237/react-native-fetch-blob/issues/331)
            fs.unlink(tmpPath).catch(() => undefined);
            // TMP_DIR 只在建構子建立一次。它之後若不見了（App 執行中系統清掉 Caches、建構子的
            // mkdir 遇到暫時性錯誤被吞掉），每一次 downloadFile 都會因目的目錄不存在而失敗，
            // 重試全部用完後圖片就一直空白到下次重啟。這裡冪等地補建（已存在時兩個平台都是成功、
            // 成本很低），重試（至少 retryDelay 之後）就有機會成功。
            fs.mkdir(TMP_DIR).catch(() => undefined);
            done();
            this.onDownloadFailed(cache, err);
        };
        cache.task = fs.downloadFile({
            fromUrl: uri,
            toFile: tmpPath,
            headers: Object.assign({}, (source.headers || {})),
            connectionTimeout: options.connectionTimeout,
            readTimeout: options.readTimeout
        });
        // readTimeout 是「多久沒收到任何資料」的閒置逾時，每收到一次資料就重新計時，
        // 所以只要對方持續涓滴就永遠不會觸發，那條連線會一直佔著併發名額。
        // 這裡補一道整筆傳輸的總時限。
        const nTotalTimeout = options.totalTimeout;
        if (nTotalTimeout > 0) {
            const nJobId = cache.task.jobId;
            oTotalTimer = setTimeout(() => {
                oTotalTimer = undefined;
                if (settled) {
                    return;
                }
                // 請原生端中止，把 socket 放掉。但不能只靠它來結束這一輪：
                // iOS 的 cancelByProducingResumeData 在伺服器支援續傳時只會產生 resumeData
                // 而不會回呼 errorCallback，promise 會永遠停在 pending，名額就再也放不掉。
                // 所以下面自己主動判定失敗，不等原生端的回應。
                try {
                    fs.stopDownload(nJobId);
                }
                catch (err) {
                    // 中止失敗就算了，反正下面已經把這一輪判定成失敗了。
                }
                fail(new Error("total timeout after " + nTotalTimeout + "ms"));
            }, nTotalTimeout);
        }
        cache.task.promise.then((res) => {
            // react-native-fs 不把 HTTP 錯誤碼當成失敗，4xx/5xx 一樣會 resolve，
            // 而且那種情況根本不會產生檔案，必須自己判斷。
            const statusCode = res ? res.statusCode : undefined;
            if ((statusCode === undefined) || (statusCode < 200) || (statusCode >= 300)) {
                throw new Error("HTTP " + statusCode);
            }
            return fs.moveFile(tmpPath, path).catch((err) => {
                // iOS 的 NSFileManager moveItemAtPath: 在目的檔已存在時會直接失敗，
                // Android 的 File.renameTo 則是覆蓋掉。uriMapper 會把不同網址正規化成
                // 同一個快取路徑，所以「另一個 entry 已經先把同一張圖放好」是正常情形；
                // 這種時候要當成成功，不然在 iOS 上會走失敗重試而白白再下載三次。
                return fs.exists(path).then((exists) => {
                    if (!exists) {
                        throw err;
                    }
                    return fs.unlink(tmpPath).catch(() => undefined);
                });
            });
        }).then(() => {
            if (settled) {
                // 看門狗已經先判定失敗了，不要再蓋回成功。
                return false;
            }
            cache.path = path;
            cache.retryCount = 0;
            done();
            return true;
        }, (err) => {
            fail(err);
            return false;
        }).then((succeeded) => {
            // notify() 會呼叫到外部的 handler，必須留在上面那段的 rejection handler 之外。
            // 否則 handler 丟出來的例外會被當成「下載失敗」，再跑一次 done() 並且把一個
            // 其實已經下載成功的 entry 拿去重試或刪掉。
            if (succeeded) {
                this.notify(uri);
            }
        });
    }
    enqueue(uri) {
        const cache = this.cache[uri];
        if (!cache || cache.downloading) {
            return;
        }
        if (this.pendingQueue.indexOf(uri) !== -1) {
            return;
        }
        if (cache.priority === true) {
            this.pendingQueue.unshift(uri);
        }
        else {
            this.pendingQueue.push(uri);
        }
        this.pump();
    }
    get(uri) {
        const cache = this.cache[uri];
        if (!cache) {
            return;
        }
        if (cache.path) {
            // We check here if IOS didn't delete the cache content
            fs.exists(cache.path).then((exists) => {
                if (exists) {
                    this.notify(uri);
                }
                else {
                    this.enqueue(uri);
                }
            }).catch(() => this.enqueue(uri));
        }
        else {
            this.enqueue(uri);
        }
    }
    notify(uri) {
        const cache = this.cache[uri];
        if (!cache) {
            return;
        }
        // 必須複製一份再走訪：handler 被呼叫時很可能會把自己 dispose 掉。
        // 每個 handler 各自包 try/catch，其中一個丟例外時其他人還是收得到通知。
        cache.handlers.slice().forEach(handler => {
            try {
                handler(cache.path);
            }
            catch (err) {
                console.log("[ImageCache] handler threw: " + uri + " - " + err.message);
            }
        });
    }
    notifyError(uri, error) {
        const cache = this.cache[uri];
        if (!cache) {
            return;
        }
        cache.errorHandlers.slice().forEach(handler => {
            try {
                handler(uri, error);
            }
            catch (err) {
                console.log("[ImageCache] error handler threw: " + uri + " - " + err.message);
            }
        });
    }
    onDownloadFailed(cache, error) {
        const { uri } = cache.source;
        if (cache.retryCount < options.maxRetryCount) {
            cache.retryCount++;
            setTimeout(() => {
                // 走 get() 而不是直接 enqueue()：uriMapper 會把不同網址正規化成同一個
                // 快取路徑，所以這段等待期間很可能已經有別的 entry 把同一張圖放好了。
                // get() 會先檢查檔案在不在，在的話直接 notify，不用再把整張圖抓一次。
                if (this.cache[uri]) {
                    this.get(uri);
                }
            }, options.retryDelay * cache.retryCount);
            return;
        }
        // 原本這裡什麼都不做：不通知、不重試、也不留下任何訊息，
        // 畫面就只能一直空著，直到元件被重新 mount 為止。
        console.log("[ImageCache] download failed: " + uri + " - " + error.message);
        this.notifyError(uri, error);
        // 整包丟掉，下次再 on() 進來就等於全新開始，重試次數也跟著歸零。
        delete this.cache[uri];
    }
    promote(uri) {
        const cache = this.cache[uri];
        if (!cache || (cache.priority === true)) {
            return;
        }
        cache.priority = true;
        // 已經排在隊伍裡的要往前挪，否則標成優先也還是卡在原來的位置。
        const nIndex = this.pendingQueue.indexOf(uri);
        if (nIndex > 0) {
            this.pendingQueue.splice(nIndex, 1);
            this.pendingQueue.unshift(uri);
        }
        this.pump();
    }
    pump() {
        while (this.pendingQueue.length > 0) {
            const uri = this.pendingQueue[0];
            const cache = this.cache[uri];
            // 優先的請求永遠在隊伍最前面，所以只要看隊首就能決定這一輪用哪個上限。
            const nLimit = (cache && (cache.priority === true)) ? options.maxConcurrentPriorityDownload : options.maxConcurrentDownload;
            if (this.activeDownloadCount >= nLimit) {
                break;
            }
            this.pendingQueue.shift();
            if (!cache) {
                continue;
            }
            // 排隊期間觀察者都走光了就不必浪費連線，下次 on() 會重新排進來。
            if ((cache.handlers.length === 0) && (cache.errorHandlers.length === 0)) {
                continue;
            }
            this.download(cache);
        }
    }
    removeStaleTempFiles() {
        // 上一次 process 被殺掉時留下來的暫存檔，開機時清一清。
        //
        // 只掃 TMP_DIR。這個目錄平常是空的、最多只有上次被殺掉時正在下載的那幾個檔，
        // 不論 BASE_DIR 累積了多少快取檔都一樣快；絕對不能改回 readDir(BASE_DIR)，
        // 原因見 TMP_DIR 的註解。
        //
        // 只刪「不是本次 SESSION_ID 開頭」的檔案，而不是刪光所有 .tmp。要防的競態：
        // ImageCache.get() 的第一次呼叫也可能來自 on()（例如沒有人先呼叫 setUriMapper），
        // 那一輪的下載可能與這裡的 readDir／unlink 交錯 —— readDir 是等 mkdir 完成後才發出的，
        // 而 Android 的下載是在 Downloader 自己的 thread 寫檔，與 readDir 之間沒有先後保證，
        // 所以 readDir 有可能列到剛開始下載的暫存檔，刪掉它會讓 moveFile 失敗而白白重下載一次。
        // 用 SESSION_ID 前綴過濾幾乎沒有成本，就把這個可能性整個排除。
        // （mkdir(TMP_DIR) 本身不需要額外防護：兩個平台的 RNFS 呼叫都依呼叫順序執行，
        // mkdir 一定在之後才發出的 downloadFile 之前完成。）
        //
        // 邊界：上一個 process 留下的檔案，前綴必然不同（SESSION_ID 每次啟動重新隨機產生），
        // 所以會被清掉；本次下載的檔案前綴必然相同，所以不會被刪。JS 重載（CodePush 重啟、
        // dev reload）也會產生新的 SESSION_ID，舊 JS 環境留下的下載已經沒有人在等結果，清掉是對的。
        //
        // 不處理的部分：這個子目錄出現之前，暫存檔是寫在 BASE_DIR 根目錄、與快取檔同一層
        // （副檔名 .tmp）。那些舊檔現在不會再被掃到、也就不會被清掉 —— 刻意不為它保留
        // 會隨快取檔數量變慢的掃描；殘留的舊檔只佔一點空間，不影響功能。
        // （哪些版本寫過這種檔案、實測過哪些裝置沒有殘留，見 docs/agent/download-pipeline.md 第七節。）
        const sOwnPrefix = SESSION_ID + "-";
        return fs.readDir(TMP_DIR).then((items) => {
            items.forEach(item => {
                if (item.name
                    && (item.name.substr(-TMP_SUFFIX.length) === TMP_SUFFIX)
                    && (item.name.indexOf(sOwnPrefix) !== 0)) {
                    fs.unlink(item.path).catch(() => undefined);
                }
            });
        }).catch(() => undefined);
    }
}
export class BaseCachedImage extends Component {
    constructor() {
        super(...arguments);
        this.retryCount = 0;
        this.retryTimer = undefined;
        this.mounted = false;
        this.handler = (path) => {
            this.retryCount = 0;
            this.setState({ path });
        };
        // ImageCache 已經重試過並且放棄了。這裡再自己排程幾次，
        // 才不會因為進畫面時剛好網路不順就永遠空白下去。
        this.errorHandler = () => {
            // 一定要先 dispose 再把 uri 清掉：dispose() 是以 this.uri 判斷要解除哪一筆訂閱，
            // 先清掉的話 componentWillUnmount() 再呼叫它就什麼都不會做。
            this.dispose();
            this.uri = undefined;
            this.setState({ path: undefined });
            if (this.retryCount >= options.componentMaxRetry) {
                return;
            }
            this.retryCount++;
            this.clearRetryTimer();
            this.retryTimer = setTimeout(() => {
                this.retryTimer = undefined;
                if (!this.mounted) {
                    return;
                }
                const source = this.props.source;
                if (isCachedImageURISource(source)) {
                    this.observe(source, this.props.mutable === true);
                }
            }, options.componentRetryDelay * this.retryCount);
        };
        // 快取檔本身壞掉時 <Image> 只會丟 onError，路徑還在、fs.exists() 也還是 true，
        // 所以永遠不會自己修好。砍掉重下一次。
        this.imageErrorHandler = (event) => {
            const path = this.state ? this.state.path : undefined;
            const uri = this.uri;
            const source = this.props.source;
            // 只有在 <Image> 真的正在顯示快取檔時才做修復。source 被換成本地圖片
            // （require() 進來的 number）時 observe() 不會被呼叫，this.uri 與 state.path 會
            // 停在前一張遠端照片上；此時本地圖片載入失敗（debug build 的 asset 是走 Metro 的 HTTP，
            // 真的會失敗）就會誤刪另一張照片那個完好的快取檔。
            if (path && uri && isCachedImageURISource(source) && (source.uri === uri) && (path !== this.brokenPath)) {
                this.brokenPath = path;
                // 同樣要先 dispose 再清 uri，否則元件在 unlink 完成前被 unmount 時，
                // componentWillUnmount() 的 dispose() 會因為 uri 已經是 undefined 而解除不掉訂閱。
                this.dispose();
                this.uri = undefined;
                this.setState({ path: undefined });
                fs.unlink(path).catch(() => undefined).then(() => {
                    // 這段是非同步的，元件很可能已經被捲出畫面卸載掉了。
                    if (!this.mounted) {
                        return;
                    }
                    // 重新讀一次 props：unlink 這段期間 source 可能又被換掉了。
                    const currentSource = this.props.source;
                    if (isCachedImageURISource(currentSource) && (currentSource.uri === uri)) {
                        this.observe(currentSource, this.props.mutable === true);
                    }
                });
            }
            const onError = this.props.onError;
            if (onError) {
                onError(event);
            }
        };
    }
    clearRetryTimer() {
        if (this.retryTimer !== undefined) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
    }
    dispose() {
        if (this.uri) {
            ImageCache.get().dispose(this.uri, this.handler, this.errorHandler);
        }
    }
    observe(source, mutable) {
        if (isObject(source) && (source.uri !== this.uri)) {
            this.dispose();
            this.uri = source.uri;
            ImageCache.get().on(source, this.handler, !mutable, this.errorHandler);
        }
    }
    getProps() {
        const props = {};
        Object.keys(this.props).forEach(prop => {
            if (prop === "source" && isObject(this.props.source) && this.props.source.uri) {
                props["source"] = this.state.path ? { uri: FILE_PREFIX + this.state.path } : {};
            }
            else if (["mutable", "component", "onError"].indexOf(prop) === -1) {
                props[prop] = this.props[prop];
            }
        });
        props["onError"] = this.imageErrorHandler;
        return props;
    }
    checkSource(source) {
        if (Array.isArray(source)) {
            throw new Error(`Giving multiple URIs to CachedImage is not yet supported.
            If you want to see this feature supported, please file and issue at
             https://github.com/wcandillon/react-native-img-cache`);
        }
        return source;
    }
    UNSAFE_componentWillMount() {
        const { mutable } = this.props;
        const source = this.checkSource(this.props.source);
        this.setState({ path: undefined });
        if (isCachedImageURISource(source)) {
            this.observe(source, mutable === true);
        }
    }
    UNSAFE_componentWillReceiveProps(nextProps) {
        const { mutable } = nextProps;
        const source = this.checkSource(nextProps.source);
        if (isCachedImageURISource(source)) {
            this.observe(source, mutable === true);
        }
    }
    componentDidMount() {
        this.mounted = true;
    }
    componentWillUnmount() {
        this.mounted = false;
        this.clearRetryTimer();
        this.dispose();
    }
}
export class CachedImage extends BaseCachedImage {
    render() {
        const props = this.getProps();
        if ((Platform.OS === 'android') && ((props.source === null) || (props.source === undefined) || ((typeof props.source === 'object') && (typeof props.source.uri !== 'string'))))
            return null;
        if (React.Children.count(this.props.children) > 0) {
            console.warn("Using <CachedImage> with children is deprecated, use <CachedImageBackground> instead.");
        }
        return React.createElement(Image, Object.assign({}, props), this.props.children);
    }
}
export class CachedImageBackground extends BaseCachedImage {
    render() {
        const props = this.getProps();
        if ((Platform.OS === 'android') && ((props.source === null) || (props.source === undefined) || ((typeof props.source === 'object') && (typeof props.source.uri !== 'string'))))
            return null;
        return React.createElement(ImageBackground, Object.assign({}, props), this.props.children);
    }
}
export class CustomCachedImage extends BaseCachedImage {
    render() {
        const { component } = this.props;
        const props = this.getProps();
        const Component = component;
        if ((Platform.OS === 'android') && ((props.source === null) || (props.source === undefined) || ((typeof props.source === 'object') && (typeof props.source.uri !== 'string'))))
            return null;
        return React.createElement(Component, Object.assign({}, props), this.props.children);
    }
}
//# sourceMappingURL=index.js.map