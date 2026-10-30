# react-native-img-cache（fork）

網路圖片快取套件：`CachedImage`／`CachedImageBackground`／`CustomCachedImage` 元件加上 `ImageCache` 管理器（下載、排程、快取檔管理）。fork 自 `wcandillon/react-native-img-cache`（上游自述已停止維護），分支 `master`。

## ⚠️ 這是公開 repo
任何人都看得到本 repo 的檔案、commit 訊息與歷史。寫進這裡的一切（程式、文件、commit 訊息、PR／issue 文字）都要能公開：
- 只寫套件本身的功能、與上游的差異、套件自己遇到的問題與修法。
- **不要寫**：哪些專案、App 或服務在使用本套件（含其名稱、目錄、檔名、函式）、使用端釘住的版本 hash、測試機或環境的實測資料、票號與內部的問題編號、內部文件或工作區的路徑、帳號與主機名稱。commit 訊息也一樣，不要加內部票號前綴。
- 使用端專屬的細節（怎麼升 pin、在哪驗證、哪個畫面用到、待確認事項）寫在**使用端專案自己的文件**，不要寫在這裡。
- 不確定某段資訊適不適合公開，就不要寫，先問使用者。push 前再看一遍即將推出的 diff 與 commit 訊息。

## 與上游的差異
- 上游最後一個 commit 是 `7a31196`（2018-11-08），其後都是本 fork 的 commit（共 13 個）：快取檔名修正（`46a4ef3`，原本 App 重啟後全部重抓）、iOS 新安裝圖片不顯示（`76a5393`）、`cacheUri()`（`f2e1145`）、`setUriMapper()`（`0976e99`，讓不同主機的網址共用同一快取檔）、react-native-fs 升到 `^2.20.0` 並消除 React 18 警告（`180b36e`）、`source` 為 `require()` number 時不當掉（`9d83580`），以及 2026-09-15 的大改 `81174b6`（下載節流、重試、失敗通知、暫存檔、`setOptions()`），2026-10-22 的 `d1d23e0`（暫存檔改放 `BASE_DIR/tmp`，開機不再掃描快取目錄）。
- 上游 `README.md` 已過時（仍寫依賴 `react-native-fetch-blob`、`on(uri, observer, immutable)` 舊簽名，且完全沒提 `cacheUri`／`setOptions`／`setUriMapper`），不要改寫它；API 以 `src/index.tsx` 與 `docs/agent/download-pipeline.md` 為準。

## 技術棧與入口
- TypeScript，單一原始檔 `src/index.tsx`；`tsc` 編成 `build/index.js`（ES module，`target`／`module` 皆 es6，保留 `import`）＋ `build/index.d.ts` ＋ `build/index.js.map`。`package.json`：`main` = `build/index.js`、`typings` = `build/index.d.ts`。
- 執行期依賴 `react-native-fs`（下載與檔案操作）與 `crypto-js`（`immutable` 快取檔名用 SHA1）。

## `build/` 是進版控的編譯輸出（最容易出錯的地方）
- `git ls-files build` 有 3 個檔案；`.gitignore` 裡的 `# build` 被註解掉（`2f0fe13` 刻意提交 build，讓使用端不用自己編譯）。`package.json` 沒有 `prepare`／`postinstall`，所以使用端從 git 安裝時**不會編譯**。
- 使用端 `import { CachedImage, ImageCache } from 'react-native-img-cache'` 實際載入的是 `node_modules/react-native-img-cache/build/index.js`（`main`）；`src/` 雖然也被裝進去，但執行期不會用到。**只改 `src/` 不重編 `build/`，對 App 完全沒有效果。**
- 規則：改 `src/index.tsx` 就必須重編 `build/`，並與 `src/` 放在**同一個 commit**（git 歷史上每個動過 `src/index.tsx` 的 commit 都同時動了 `build/`）。
- 重編：`npm run build`（= `tsc --pretty --skipLibCheck`）在現行環境**不能直接用**（`devDependencies` 的 TypeScript 版本過舊，編不過現行原始碼）。已驗證的做法：用 TypeScript 5.0.4（`81174b6` 使用的版本）並讓 `node_modules` 能解析 `react`／`react-native` 型別（任何一個 RN 0.77 專案的 `node_modules` 即可），執行 `node <該 node_modules>/typescript/bin/tsc --skipLibCheck -p .`；用目前原始碼編出的 `index.js`、`index.d.ts`、`index.js.map` 與已提交的 `build/` 完全相同。
- 編完用 `git diff --stat build/` 確認只有預期的變動，再 commit。

## 常用指令
- 本 repo 沒有測試檔。`npm test`（= `npm run lint && npm run build`）不可當驗證依據（build 編不過，見上）。
- 行為驗證：把 `react-native-fs` 換成記憶體版本的 jest 測試（併發上限、重試、總時限、`uriMapper` 共用路徑、`<Image>` 自癒等）要放在使用端專案跑；它載入的是該專案已安裝的版本，改完本 repo 要先把新 commit 裝進去才測得到。

## 發佈與引用方式（改完必須做）
使用端的 `package.json` 寫 `"react-native-img-cache": "https://github.com/howg0924/react-native-img-cache.git"`（**沒有 hash**），實際版本由 `yarn.lock` 的 `resolved ...#<hash>` 決定。

- 流程：改 `src/` → 重編 `build/` → 同一個 commit → push 到 `origin/master` → 使用端更新 `yarn.lock` 的 `resolved` hash → 在使用端跑上面的行為測試。agent 改完不要自行 push，除非使用者明確要求。

## 與 react-native-fs 原生端的關係
- 本套件自己不需要被 patch。
- `81174b6` 的總時限機制在 iOS 需要 react-native-fs 原生端的配套（`FS.common.js`、`Downloader.m`、`RNFSManager.m`）：對沒登記 `resumable` 的下載呼叫 `stopDownload` 一律當成中止、並釋放 downloader／session；沒有它，被中止的下載在原生端會一直留在登記表。JS 端不依賴它也能放掉併發名額（`download()` 自己判定失敗）。
- 使用端的 jest 設定必須轉換 `react-native-img-cache`（`build/index.js` 是 ES module）；改 `build` 的輸出格式前要先看那份設定。

## 必守規則
- 保持公開 API 向下相容：`on`／`dispose`／`cacheUri` 新增的參數都是選用的；不要移除或改簽名。
- `cacheUri()` 無論成敗都必須 resolve（失敗為 `undefined`）：呼叫端用 `await`，in-app 通知曾因此整個不出現。
- 下載流程的每個保護機制（`settled` 旗標、每次不同的暫存檔名、`notify()` 複製 handler 陣列、重試走 `get()`、`moveFile` 失敗但目的檔存在視為成功）各對應一個實機症狀，改動前先讀 `docs/agent/download-pipeline.md` 的對應段落。
- **開機（建構子）絕對不可以對 `BASE_DIR` 做 `readDir` 或任何會隨快取檔數量變慢的走訪**：快取只增不減（目前不做任何淘汰），久用的裝置有數萬檔，iOS 上掃一次要數秒，還會佔住 `react-native-fs` 的串列佇列讓啟動畫面卡住（實機 3.7 萬檔要 6.4 秒）。暫存檔因此放在 `BASE_DIR/tmp`，清理只掃那個子目錄；見 `docs/agent/download-pipeline.md` 第七節。守護測試不在本 repo（本 repo 沒有測試檔），要放在使用端專案——改本 repo 或升使用端的 pin 後都要在使用端實跑。
- 預設值改動要考慮使用端可能在執行期以遠端設定重複呼叫 `setOptions()`：它必須維持冪等、對不合法值寬容。

## 地雷
- `package.json.bak`、`.gitignore.bak`、`src/index.tsx.bak`：舊備份，被 `*.bak` 忽略、不在版控內；內容與現行不同（例如 `.gitignore.bak` 會忽略 `build`），不要拿來還原。
- `package.json` 的 `repository`／`homepage` 仍指向上游，`version` 是 1.7.0（自 2019-12 的 `07a7b89` 後沒再 bump，連 `81174b6` 大改也沒有）；辨識版本只能靠 commit hash。
- `BaseCachedImage` 仍使用 `UNSAFE_componentWillMount`／`UNSAFE_componentWillReceiveProps`：依 React 19 升級指南它們**並未被移除**（React 19 移除的是 legacy context、string refs、`propTypes`、function component 的 `defaultProps` 等；`UNSAFE_` 生命週期仍可用，僅 StrictMode 會警告；未在專案內實測）。不必為了升 React 19 而急著改。
- `ImageCache.cancel()` 只呼叫 `stopDownload` 而不標記取消，被中止的下載會走失敗路徑並在延遲後被重試；呼叫或修改前先確認這個行為。
- `ImageCache.clear()` 在有下載進行中時清空 cache，進行中的訂閱者收不到成功或失敗通知，`cacheUri` 的 Promise 不會結束。
- `render()` 在 Android 上遇到沒有字串 `uri` 的 `source` 會回傳 `null`（`178b6c5`／`9bf0f5d`：該情形會在少數 Android 機型造成原生 heap corruption 閃退，崩潰回報看不到）；不要移除。

## 延伸文件（需要時才讀）
- `docs/agent/download-pipeline.md` — 要改下載排程／重試／逾時／快取檔處理，或排查圖片顯示不出來時
- `README.md` — 上游說明（已過時），不要改寫
