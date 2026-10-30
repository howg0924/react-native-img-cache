> 用途：說明 `src/index.tsx` 的下載排程、失敗／重試、暫存檔、元件自癒與 `setOptions()` 參數，以及每一段「為什麼這樣寫」。　何時讀：要改 `ImageCache` 或 `BaseCachedImage` 的任何行為、調整逾時／併發、或排查「圖片顯示不出來／黑塊」時。
> 驗證基準：commit d1d23e0（2026-10-22；在 81174b6〔2026-09-15〕之上，暫存檔改放 `BASE_DIR/tmp` 子目錄，見第三節與第七節）

這些設計全部來自 `81174b6` 的修正（commit 訊息有完整的實測數據）。原則：每個保護機制都對應一個實機上看過的症狀，不要因為「看起來多餘」就移除。

## 一、公開 API（皆向下相容；上游 `README.md` 只涵蓋 `clear`／`bust`／`cancel`／`on`／`dispose` 的舊簽名）

| API | 簽名 | 備註 |
|---|---|---|
| `ImageCache.get()` | singleton | constructor 會 `mkdir` 暫存子目錄 `BASE_DIR/tmp`（連快取目錄一起建）並清掉上次殘留的 `*.tmp`（`removeStaleTempFiles`，**只掃 `tmp` 子目錄**，見第七節） |
| `on` | `on(source, handler, immutable?, errorHandler?, priority?)` | 沒傳 `errorHandler` 的訂閱者在下載放棄時**收不到任何通知** |
| `dispose` | `dispose(uri, handler, errorHandler?)` | 以 `filter` 重建陣列（原本在 `forEach` 內 `splice` 會跳過下一個 handler） |
| `cacheUri` | `cacheUri(uri, priority?) => Promise<string \| undefined>` | 成功回傳快取檔路徑、失敗回傳 `undefined`，**一定會 resolve**（呼叫端 `await` 不會卡死）；第二參數 `true` 走優先通道 |
| `setOptions` | `setOptions(options?: ImageCacheOptions)` | 冪等；未指定或不合法的鍵回到預設值（驗證見 `OPTION_MIN`） |
| `setUriMapper`／`clearUriMapper` | `(uri) => string` | 讓不同主機的網址對到同一個快取檔；快取路徑以「映射後」的網址計算 |
| `bust`／`cancel`／`clear` | — | `clear()` 砍整個目錄後會補 `mkdir(TMP_DIR)`（連快取目錄一起建），否則之後每次下載都會失敗；`cancel()` 的行為見 `CLAUDE.md` 地雷 |

元件：`CachedImage`、`CachedImageBackground`、`CustomCachedImage`（皆繼承 `BaseCachedImage`）。`source` 必須是 `{uri: string}` 才會被快取；`source` 是 `require()` 來的 number 時直接放行（`isCachedImageURISource`，`9d83580`）。

## 二、下載排程（`ImageCache.enqueue` → `pump` → `download`）
- `pendingQueue` 存 uri；一般請求 `push`，優先請求（`priority === true`）`unshift` 到隊首。
- `pump()` 只看隊首決定上限：優先請求用 `maxConcurrentPriorityDownload`，其餘用 `maxConcurrentDownload`。兩者差額是保留給「呼叫端正在 `await` 這一張圖」的名額（in-app 通知、聊天圖片）；清單那種每格一次的批次呼叫**不可**傳 `priority`，否則保留名額會被自己吃光。
- `promote()`：已排隊或已存在的 entry 之後又以優先請求進來時，往前挪。
- 排隊期間觀察者全走光的 entry 不下載（`pump` 內檢查 `handlers`／`errorHandlers`）。
- 起因：`react-native-fs` 的 Android 端每次 `downloadFile` 直接開一條原生 thread、完全不節流；實測三欄清單同時衝到 144 條連線，146 次下載失敗 135 次（連線逾時）。

## 三、單次下載（`download`）
1. 先寫到 `BASE_DIR/tmp/<SESSION_ID>-<流水號>.tmp`，成功後 `moveFile` 到正式路徑（同一個磁碟區，是 rename）。暫存檔名**必須每次不同**：`uriMapper` 會讓兩個 cache entry 共用同一個 `path`，固定檔名會讓兩邊同時寫同一檔而寫壞；檔名不再由 `path` 衍生，改用「本次啟動隨機產生的 `SESSION_ID` ＋ 遞增流水號」。
2. `done()` 只能生效一次（`settled` 旗標）；`activeDownloadCount` 多扣一次，併發上限就整個失效。
3. 失敗判定 `fail()`（失敗時除了刪暫存檔，也會冪等地補建 `TMP_DIR`，見第七節）：`downloadFile` reject、HTTP 狀態碼不在 2xx（`react-native-fs` 不把 4xx/5xx 當失敗，promise 照樣 resolve，必須自己判斷）、`moveFile` 失敗**且**目的檔不存在。
4. `moveFile` 失敗但目的檔已存在視為成功（iOS 的 `moveItemAtPath:` 目的檔存在會失敗，Android 的 `renameTo` 會覆蓋；不處理的話 iOS 會白白重下三次）。
5. 總時限 `totalTimeout`：`readTimeout` 是閒置計時，對方持續涓滴就永不觸發。到期時 `fs.stopDownload()` 後**自己判定失敗**，不等原生回應（iOS 在伺服器支援續傳時 `cancelByProducingResumeData` 不回呼 error，promise 會永遠 pending）。iOS 需要 react-native-fs 原生端配套，見 `CLAUDE.md`「與 react-native-fs 原生端的關係」。
6. `notify()` 必須留在成功／失敗那段 `then` 之外（最後一個 `.then((succeeded) => ...)`）：handler 丟出的例外不能被當成「下載失敗」而再次 `done()`。

## 四、失敗與重試（兩層，擁有者不同）
- 快取層（`onDownloadFailed`）：重試 `maxRetryCount` 次，第 n 次等 `retryDelay * n`；重試走 `get()` 而非直接 `enqueue()`，因為等待期間別的 entry 可能已把同一個檔放好。用完後 `console.log` 一行、呼叫所有 `errorHandlers`，並 `delete this.cache[uri]`（重試計數歸零）。
- 元件層（`BaseCachedImage.errorHandler`）：再重試 `componentMaxRetry` 次，第 n 次等 `componentRetryDelay * n`；只有仍掛在畫面上的元件會重試。先 `dispose()` 再清 `this.uri`（順序不可顛倒，否則卸載時解除不掉訂閱）。
- 單張圖最壞嘗試 3 × 2 = 6 次（預設值）。
- 快取檔損毀：`<Image>` 的 `onError`（`imageErrorHandler`）會刪掉該快取檔並重新 `observe`；每個 path 只修一次（`brokenPath`），且只在 `<Image>` 真的正在顯示該快取檔時才修（`source` 換成本地圖片時不可誤刪別張照片的快取檔）。

## 五、`setOptions()` 參數與預設值（定義在 `src/index.tsx::DEFAULT_OPTIONS`）

| 鍵 | 預設 | 最小值 | 意義 |
|---|---|---|---|
| `maxConcurrentDownload` | 6 | 1 | 一般（批次）同時下載數 |
| `maxConcurrentPriorityDownload` | 8 | 1 | 優先請求可用上限；被設得比一般上限低時會被拉回等於一般上限 |
| `connectionTimeout` | 6000 ms | 1 | 建立連線期限（`react-native-fs` 預設 5000，高併發下大量誤殺） |
| `readTimeout` | 15000 ms | 1 | 閒置逾時 |
| `totalTimeout` | 120000 ms | 0 | 整筆傳輸總時限，0 = 不設。120 秒是實測值：滿版照片 130–200 KB，30 秒會在弱網下砍掉正常傳輸 |
| `maxRetryCount` | 2 | 0 | 快取層重試次數（不含第一次） |
| `retryDelay` | 1000 ms | 0 | 第 n 次等 `retryDelay * n` |
| `componentMaxRetry` | 1 | 0 | 元件層重試次數 |
| `componentRetryDelay` | 6000 ms | 0 | 第 n 次等 `componentRetryDelay * n` |

使用端可能在執行期以遠端設定重複呼叫 `setOptions`，所以它必須維持冪等、對不合法值寬容（非數字、`NaN`、`Infinity`、低於下限一律忽略）。

## 六、使用端如何使用
- 啟動時呼叫 `setUriMapper(...)`（選用）與 `setOptions(options)`；使用者正在等的圖（通知、聊天圖片）用 `cacheUri(url, true)`，其餘用 `CachedImage` 元件。
- 使用端的設定若會在執行期被遠端覆寫，要整包重新呼叫 `setOptions()`（冪等）。
- 行為測試放在使用端專案（本 repo 沒有測試檔）：把 `react-native-fs` 換成記憶體版本，涵蓋併發上限、重試、總時限、`uriMapper` 共用路徑、`<Image>` 自癒；測的是該專案已安裝的版本。

## 七、暫存目錄與開機清理（2026-10-22 修正：啟動畫面卡 6 秒）
- **規則：開機時絕對不能走訪 `BASE_DIR`。** 快取檔只增不減（目前刻意不做任何淘汰），久用的裝置會累積數萬檔（實機 3.7 萬檔、804 MB）。iOS 的 `RNFS.readDir` 對每個檔案各做一次 `attributesOfItemAtPath`，約 0.17 ms／檔，掃一次 6.4 秒；`react-native-fs` iOS 端所有呼叫共用同一條串列佇列，`readDir` 跑完之前使用端建立快取目錄的 `mkdir` 與每張圖的 `exists`／`downloadFile` 全部排在後面，App 卡在啟動畫面。`81174b6` 的 `removeStaleTempFiles` 就是這樣引入的退化。
- 做法：下載暫存檔放 `TMP_DIR = BASE_DIR + "/tmp"`；建構子 `mkdir(TMP_DIR)`（iOS `withIntermediateDirectories:YES`、Android `mkdirs()`，會連 `BASE_DIR` 一起建，目錄已存在也算成功）後只 `readDir(TMP_DIR)`。`clear()` 補回的也是 `TMP_DIR`。
- 清理只刪「檔名不是以本次 `SESSION_ID + "-"` 開頭」的 `*.tmp`。理由：`ImageCache.get()` 第一次呼叫可能來自 `on()`，那一輪的下載可能與清理的 `readDir`／`unlink` 交錯（`readDir` 是 `mkdir` 完成後才發出的；Android 的下載在 `Downloader` 自己的 thread 寫檔，與 `readDir` 之間沒有先後保證），否則會刪到剛開始下載的暫存檔（後果是 `moveFile` 失敗後重試，白下載一次）。`mkdir(TMP_DIR)` 本身不需要防護：兩個平台的 RNFS 呼叫都依呼叫順序執行（Android 的 `mkdir` 是同步的 `@ReactMethod`，與 `downloadFile` 在同一條 native modules thread），`mkdir` 一定在之後才發出的 `downloadFile` 之前完成。
- 不處理：`81174b6` 時代寫在 `BASE_DIR` 根目錄的舊 `*.tmp`（2026-10-22 兩支測試機實測為 0 個；其他裝置未驗證）。這類時間相關的事實放在這裡、不放程式註解。
- **補建**：`TMP_DIR` 只在建構子建立一次，所以 `fail()` 會冪等地再 `mkdir(TMP_DIR)`（已存在時兩平台都成功）。否則它若之後不見了（App 執行中系統清掉 Caches、建構子的 `mkdir` 遇到暫時性錯誤被吞掉；使用端若只建 `BASE_DIR` 也不會補），每次 `downloadFile` 都會因目的目錄不存在而失敗，快取層與元件層的重試用完後圖片一直空白到下次重啟。
- 守護測試**不在本 repo**（本 repo 沒有測試檔），放在使用端專案的「暫存檔目錄：開機不可以掃描整個快取目錄」一組：建構子只 `readDir(TMP_DIR)`、暫存檔寫在 `tmp` 底下、清理不誤刪本次下載、`clear()` 補回 `tmp`、`tmp` 不見時下載失敗後補建。該測試載入的是使用端專案 `node_modules` 裡已安裝的版本，所以**改本 repo 或升級使用端的 pin 之後都必須在使用端實跑**；它的記憶體版 fs 會在目的目錄不存在時讓 `downloadFile` 失敗。
- 實機／模擬器驗證（2026-10-22，`d1d23e0`）：iOS 實機（開機取樣 `readDir` 6,488→0、離開橘色啟動畫面 7.1～7.5 s→1.1～1.6 s、新增 13 張圖後 `tmp` 為空）；Android 模擬器（API 36，乾淨狀態連父目錄 `mkdir`、下載、進行中 `.tmp` 檔名與大小、`tmp` 被刪後補建、開機清理、`clear()`）。commit 訊息裡寫的「Android 未驗證」是 push 當時的狀態，之後已補驗。
