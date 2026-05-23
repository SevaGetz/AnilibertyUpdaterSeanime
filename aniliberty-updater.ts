/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * AniLiberty Torrent Updater for Seanime
 *
 * Rules learned from Seanime plugin sandbox:
 * - ALL helpers must be defined inside $ui.register (no global scope access)
 * - $storage CANNOT be called synchronously during registration — only inside
 *   callbacks (onClick, render, onReady, etc.)
 * - $cron IS available inside $ui.register
 */

function init() {
    $ui.register((ctx) => {

        // ── Constants ──────────────────────────────────────────────────────────
        const API_BASE   = "https://aniliberty.top/api/v1"
        const KEY_STATE  = "aniliberty-updater:state"
        const KEY_LIST   = "aniliberty-updater:releases"
        const KEY_MINS   = "aniliberty-updater:interval"
        const KEY_AUTO   = "aniliberty-updater:auto-check"

        // ── Storage helpers (call only inside callbacks, never at init time) ───
        function getState(): Record<string, any> {
            try { return $storage.get(KEY_STATE) || {} } catch(_) { return {} }
        }
        function setState(s: Record<string, any>): void {
            try { $storage.set(KEY_STATE, s) } catch(_) {}
        }
        function getReleases(): Array<{ id: number, name: string }> {
            try { return $storage.get(KEY_LIST) || [] } catch(_) { return [] }
        }
        function setReleases(r: Array<{ id: number, name: string }>): void {
            try { $storage.set(KEY_LIST, r) } catch(_) {}
        }
        function getIntervalMins(): number {
            try { return $storage.get(KEY_MINS) || 30 } catch(_) { return 30 }
        }
        function setIntervalMins(m: number): void {
            try { $storage.set(KEY_MINS, m) } catch(_) {}
        }
        function getAutoCheckEnabled(): boolean {
            try {
                const v = $storage.get(KEY_AUTO)
                return typeof v === "boolean" ? v : true
            } catch(_) {
                return true
            }
        }
        function setAutoCheckEnabled(v: boolean): void {
            try { $storage.set(KEY_AUTO, v) } catch(_) {}
        }

        // ── Torrent picking ────────────────────────────────────────────────────
        function pickBest(list: any[]): any {
            if (!list || list.length === 0) return null
            const sorted = list.slice().sort((a: any, b: any) =>
                (b.updated_at || "").localeCompare(a.updated_at || "")
            )
            const top = sorted[0].updated_at
            const fresh = sorted.filter((t: any) => t.updated_at === top)
            return fresh.reduce((m: any, t: any) => (t.size < m.size ? t : m))
        }

        // ── API calls ──────────────────────────────────────────────────────────
        async function apiFetchTorrents(releaseId: number): Promise<any[]> {
            const r = await ctx.fetch(API_BASE + "/anime/torrents/release/" + releaseId, { timeout: 15 })
            if (!r.ok) return []
            return r.json() || []
        }

        async function apiSearch(query: string): Promise<any[]> {
            const r = await ctx.fetch(
                API_BASE + "/app/search/releases?query=" + encodeURIComponent(query),
                { timeout: 15 }
            )
            if (!r.ok) throw new Error("AniLiberty API: HTTP " + r.status + " " + (r.statusText || ""))
            const d = r.json()
            return Array.isArray(d) ? d : (d && d.data ? d.data : [])
        }

        async function getDownloadDestination(): Promise<string> {
            try {
                const settings = await ctx.appSettings.get<any>()
                const library = settings.library || {}
                return library.libraryPath || (library.libraryPaths && library.libraryPaths[0]) || ""
            } catch(_) {
                return ""
            }
        }

        function buildBaseUrl(host: any, port: any, fallbackPort: number): string {
            let h = String(host || "127.0.0.1").trim()
            if (!h) h = "127.0.0.1"
            if (h.indexOf("http://") === 0 || h.indexOf("https://") === 0) {
                return h.replace(/\/+$/, "")
            }
            const hasPort = h.indexOf(":") >= 0 && h.indexOf("]") < h.length - 1
            return "http://" + h + (hasPort ? "" : ":" + String(port || fallbackPort))
        }

        function cookieHeader(cookies: Record<string, string>): string {
            const parts: string[] = []
            for (const k in cookies) parts.push(k + "=" + cookies[k])
            return parts.join("; ")
        }

        function base64Encode(input: string): string {
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            let out = ""
            let i = 0
            while (i < input.length) {
                const c1 = input.charCodeAt(i++) & 255
                const c2 = i < input.length ? input.charCodeAt(i++) & 255 : NaN
                const c3 = i < input.length ? input.charCodeAt(i++) & 255 : NaN
                out += chars.charAt(c1 >> 2)
                out += chars.charAt(((c1 & 3) << 4) | (isNaN(c2) ? 0 : (c2 >> 4)))
                out += isNaN(c2) ? "=" : chars.charAt(((c2 & 15) << 2) | (isNaN(c3) ? 0 : (c3 >> 6)))
                out += isNaN(c3) ? "=" : chars.charAt(c3 & 63)
            }
            return out
        }

        async function addToQbittorrent(torrent: any, magnet: string, destination: string): Promise<void> {
            const base = buildBaseUrl(torrent.qbittorrentHost, torrent.qbittorrentPort, 8080)
            const username = torrent.qbittorrentUsername || torrent.qbittorrentUser || ""
            const password = torrent.qbittorrentPassword || torrent.qbittorrentPass || ""
            let cookie = ""

            if (username || password) {
                const login = await ctx.fetch(base + "/api/v2/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: "username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password),
                    timeout: 15,
                })
                const text = login.text()
                if (!login.ok || text.indexOf("Ok.") < 0) {
                    throw new Error("qBittorrent login failed")
                }
                cookie = cookieHeader(login.cookies || {})
            }

            let body = "urls=" + encodeURIComponent(magnet)
            if (destination) body += "&savepath=" + encodeURIComponent(destination)
            const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" }
            if (cookie) headers["Cookie"] = cookie
            const added = await ctx.fetch(base + "/api/v2/torrents/add", {
                method: "POST",
                headers,
                body,
                timeout: 20,
            })
            const text = added.text()
            if (!added.ok || (text && text.toLowerCase().indexOf("fails") >= 0)) {
                throw new Error("qBittorrent add failed: HTTP " + added.status)
            }
        }

        async function addToTransmission(torrent: any, magnet: string, destination: string): Promise<void> {
            const base = buildBaseUrl(torrent.transmissionHost, torrent.transmissionPort, 9091)
            const username = torrent.transmissionUsername || torrent.transmissionUser || ""
            const password = torrent.transmissionPassword || torrent.transmissionPass || ""
            const headers: Record<string, string> = { "Content-Type": "application/json" }
            if (username || password) {
                headers["Authorization"] = "Basic " + base64Encode(String(username) + ":" + String(password))
            }
            const payload = JSON.stringify({
                method: "torrent-add",
                arguments: {
                    filename: magnet,
                    "download-dir": destination || undefined,
                },
            })
            let r = await ctx.fetch(base + "/transmission/rpc", {
                method: "POST",
                headers,
                body: payload,
                timeout: 20,
            })
            const sessionId = r.headers["X-Transmission-Session-Id"] || r.headers["x-transmission-session-id"]
            if (r.status === 409 && sessionId) {
                headers["X-Transmission-Session-Id"] = sessionId
                r = await ctx.fetch(base + "/transmission/rpc", {
                    method: "POST",
                    headers,
                    body: payload,
                    timeout: 20,
                })
            }
            const d = r.json()
            if (!r.ok || (d && d.result && d.result !== "success")) {
                throw new Error("Transmission add failed: " + (d && d.result ? d.result : "HTTP " + r.status))
            }
        }

        async function downloadMagnet(magnet: string): Promise<void> {
            if (!magnet) throw new Error("У торрента нет magnet-ссылки")
            const settings = await ctx.appSettings.get<any>()
            const torrent = settings && settings.torrent ? settings.torrent : {}
            const client = String(torrent.defaultTorrentClient || "").toLowerCase()
            const destination = await getDownloadDestination()
            if (client.indexOf("transmission") >= 0) {
                await addToTransmission(torrent, magnet, destination)
                return
            }
            await addToQbittorrent(torrent, magnet, destination)
        }

        // ── Core check ────────────────────────────────────────────────────────
        async function checkOne(
            release: { id: number, name: string },
            state: Record<string, any>
        ): Promise<{ state: Record<string, any>, changed: boolean, message: string }> {
            const key = String(release.id)
            const torrents = await apiFetchTorrents(release.id)
            const best = pickBest(torrents)
            if (!best) return { state, changed: false, message: "Торренты не найдены" }

            const newHash  = (best.hash || "").toLowerCase()
            const prevHash = (state[key] && state[key].hash ? state[key].hash : "").toLowerCase()
            let all: any[] = []
            try { all = await ctx.torrentClient.getTorrents() } catch(_) {}
            const alreadyInClient = all.find((t: any) => (t.hash || "").toLowerCase() === newHash)
            if (newHash === prevHash && alreadyInClient) {
                return { state, changed: false, message: "Уже в торрент-клиенте" }
            }

            // Pause old torrent in client if found
            if (prevHash) {
                try {
                    const old = all.find((t: any) => (t.hash || "").toLowerCase() === prevHash)
                    if (old) await ctx.torrentClient.pauseTorrents([old.hash])
                } catch(_) {}
            }

            ctx.toast.info("AniLiberty: обновление «" + release.name + "»")
            await downloadMagnet(best.magnet)
            ctx.toast.success("AniLiberty: «" + release.name + "» — торрент добавлен")

            const next = JSON.parse(JSON.stringify(state))
            next[key] = {
                hash: newHash,
                updated_at: best.updated_at || "",
                description: best.description || "",
            }
            return { state: next, changed: true, message: newHash === prevHash ? "Торрент добавлен повторно" : "Торрент добавлен" }
        }

        async function runCheck(): Promise<void> {
            const releases = trackedReleases.get()
            if (!releases.length) return
            let state = getState()
            for (let i = 0; i < releases.length; i++) {
                const release = releases[i]
                const key = String(release.id)
                const statuses = JSON.parse(JSON.stringify(checkStatuses.get() || {}))
                statuses[key] = "Проверяется..."
                checkStatuses.set(statuses)
                tray.update()
                try {
                    const result = await checkOne(release, state)
                    state = result.state
                    const nextStatuses = JSON.parse(JSON.stringify(checkStatuses.get() || {}))
                    nextStatuses[key] = result.changed
                        ? result.message + ": " + new Date().toLocaleTimeString()
                        : result.message + ": " + new Date().toLocaleTimeString()
                    checkStatuses.set(nextStatuses)
                    tray.update()
                } catch(e) {
                    const nextStatuses = JSON.parse(JSON.stringify(checkStatuses.get() || {}))
                    nextStatuses[key] = e && e.message ? "Ошибка: " + e.message : "Ошибка проверки"
                    checkStatuses.set(nextStatuses)
                    tray.update()
                }
            }
            setState(state)
        }

        // ── Interval ───────────────────────────────────────────────────────────
        const statusText = ctx.state("Ожидание...")

        // Keep a reference to the cancel function so we can restart with new interval
        let cancelInterval: (() => void) | null = null

        function startCron(autoOverride?: boolean): void {
            if (cancelInterval) {
                cancelInterval()
                cancelInterval = null
            }
            const auto = typeof autoOverride === "boolean" ? autoOverride : autoCheckEnabled.get()
            if (!auto) {
                statusText.set("Автопроверка выключена")
                tray.update()
                return
            }
            const mins = getIntervalMins()
            const ms = mins * 60 * 1000
            cancelInterval = ctx.setInterval(() => {
                runCheck()
                    .then(() => {
                        statusText.set("Последняя проверка: " + new Date().toLocaleTimeString())
                        tray.update()
                    })
                    .catch(() => {
                        statusText.set("Ошибка при проверке")
                        tray.update()
                    })
            }, ms)
            statusText.set("Запущен (каждые " + mins + " мин.)")
            tray.update()
        }

        // ── UI refs — no $storage calls here ──────────────────────────────────
        const searchQuery   = ctx.fieldRef("")
        // intervalInput default is a plain string literal, not a $storage call
        const intervalInput = ctx.fieldRef("30")
        const searchResults = ctx.state<any[]>([])
        const isSearching   = ctx.state(false)
        const searchError   = ctx.state("")
        const trackedReleases = ctx.state<Array<{ id: number, name: string }>>([])
        const checkStatuses = ctx.state<Record<string, string>>({})
        const autoCheckEnabled = ctx.state(true)
        const settingsOpen = ctx.state(false)

        // ── Tray ───────────────────────────────────────────────────────────────
        const tray = ctx.newTray({
            iconUrl: "https://aniliberty.top/favicon.ico",
            withContent: true,
            width: "420px",
            minHeight: "200px",
        })

        // Start cron after tray is created (still inside register, but after refs)
        // Use ctx.setTimeout so it runs after the current call stack finishes
        ctx.setTimeout(() => {
            trackedReleases.set(getReleases())
            const auto = getAutoCheckEnabled()
            autoCheckEnabled.set(auto)
            intervalInput.setValue(String(getIntervalMins()))
            startCron(auto)
        }, 0)

        // ── Render ─────────────────────────────────────────────────────────────
        tray.render(() => {
            // $storage reads are safe inside render (it's a callback)
            const releases = trackedReleases.get()
            const results  = searchResults.get()
            const err      = searchError.get()
            const statuses = checkStatuses.get() || {}
            const showSettings = settingsOpen.get()
            const autoEnabled = autoCheckEnabled.get()

            const sectionTitle = (title: string, meta?: string) =>
                tray.text(meta ? title + " (" + meta + ")" : title, {
                    style: { fontWeight: "700", fontSize: "13px" },
                })

            const releaseItems = releases.length === 0
                ? [tray.text("Пока ничего не отслеживается", { style: { color: "var(--muted)", fontSize: "12px" } })]
                : releases.map((r) =>
                    tray.flex([
                        tray.stack([
                            tray.text(r.name, { style: { fontSize: "13px", fontWeight: "600" } }),
                            tray.text(statuses[String(r.id)] || "Ещё не проверялся", {
                                style: { color: "var(--muted)", fontSize: "11px" },
                            }),
                        ], { gap: 2, style: { flex: "1", minWidth: "0" } }),
                        tray.button("Удалить", {
                            intent: "alert-subtle",
                            size: "xs",
                            onClick: ctx.eventHandler("rm-" + r.id, () => {
                                const next = trackedReleases.get().filter(x => x.id !== r.id)
                                setReleases(next)
                                trackedReleases.set(next)
                                const s = getState()
                                delete s[String(r.id)]
                                setState(s)
                                tray.update()
                            }),
                        }),
                    ], {
                        gap: 8,
                        direction: "row",
                        style: {
                            alignItems: "center",
                            width: "100%",
                            padding: "8px 10px",
                            border: "1px solid var(--border)",
                            borderRadius: "8px",
                        },
                    })
                )

            const resultItems = results.map((item: any, i: number) => {
                const title = item.name && item.name.main ? item.name.main : "Release " + item.id
                const subtitle = (item.name && item.name.english ? item.name.english + " · " : "") +
                    (item.year || "?") + " · ID " + item.id
                return tray.flex([
                    tray.stack([
                        tray.text(title, { style: { fontSize: "13px", fontWeight: "600" } }),
                        tray.text(subtitle, { style: { color: "var(--muted)", fontSize: "11px" } }),
                    ], { gap: 2, style: { flex: "1", minWidth: "0" } }),
                    tray.button("Добавить", {
                        intent: "primary-subtle",
                        size: "xs",
                        onClick: ctx.eventHandler("add-" + i, () => {
                            const list = trackedReleases.get().slice()
                            if (list.find((x: any) => x.id === item.id)) {
                                ctx.toast.warning("Уже отслеживается")
                                return
                            }
                            list.push({ id: item.id, name: title })
                            setReleases(list)
                            trackedReleases.set(list)
                            ctx.toast.success("Добавлен: " + title)
                            searchResults.set([])
                            searchError.set("")
                            tray.update()
                        }),
                    }),
                ], {
                    gap: 8,
                    direction: "row",
                    style: {
                        alignItems: "center",
                        width: "100%",
                        padding: "8px 10px",
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                    },
                })
            })

            return tray.stack([
                tray.stack([
                    tray.flex([
                        tray.stack([
                            tray.text("AniLiberty Updater", { style: { fontWeight: "800", fontSize: "15px" } }),
                            tray.text(statusText.get(), { style: { color: "var(--muted)", fontSize: "12px" } }),
                        ], { gap: 2, style: { flex: "1", minWidth: "0" } }),
                        tray.button("Проверить", {
                            intent: "success-subtle",
                            size: "sm",
                            onClick: ctx.eventHandler("check-btn", () => {
                                statusText.set("Проверка...")
                                tray.update()
                                runCheck()
                                    .then(() => {
                                        statusText.set("Проверено: " + new Date().toLocaleTimeString())
                                        tray.update()
                                    })
                                    .catch((e) => {
                                        statusText.set("Ошибка проверки")
                                        ctx.toast.error(e && e.message ? e.message : "Ошибка проверки")
                                        tray.update()
                                    })
                            }),
                        }),
                        tray.button("⚙", {
                            size: "sm",
                            onClick: ctx.eventHandler("settings-toggle", () => {
                                settingsOpen.set(!settingsOpen.get())
                                tray.update()
                            }),
                        }),
                    ], { gap: 8, direction: "row", style: { alignItems: "flex-start", width: "100%" } }),
                ], {
                    gap: 0,
                    style: { position: "relative" },
                }),

                ...(showSettings ? [
                    tray.stack([
                        tray.flex([
                            tray.stack([
                                tray.text("Автопроверка", { style: { fontSize: "13px", fontWeight: "600" } }),
                                tray.text(autoEnabled ? "По интервалу" : "Только вручную", {
                                    style: { color: "var(--muted)", fontSize: "11px" },
                                }),
                            ], { gap: 2, style: { flex: "1", minWidth: "0" } }),
                            tray.button(autoEnabled ? "Вкл" : "Выкл", {
                                intent: autoEnabled ? "success-subtle" : "alert-subtle",
                                size: "sm",
                                onClick: ctx.eventHandler("auto-toggle", () => {
                                    const next = !autoCheckEnabled.get()
                                    autoCheckEnabled.set(next)
                                    setAutoCheckEnabled(next)
                                    startCron(next)
                                }),
                            }),
                        ], { gap: 8, direction: "row", style: { alignItems: "center", width: "100%" } }),

                        tray.flex([
                            tray.input("Минуты", { fieldRef: intervalInput, style: { width: "82px" } }),
                            tray.button("OK", {
                                size: "sm",
                                onClick: ctx.eventHandler("interval-btn", () => {
                                    const val = parseInt(intervalInput.current, 10)
                                    if (isNaN(val) || val < 1) {
                                        ctx.toast.error("Введите число больше 0")
                                        return
                                    }
                                    setIntervalMins(val)
                                    startCron()
                                }),
                            }),
                        ], { gap: 8, direction: "row" }),
                    ], {
                        gap: 10,
                        style: {
                            position: "absolute",
                            top: "54px",
                            right: "12px",
                            zIndex: "50",
                            width: "260px",
                            padding: "10px",
                            border: "1px solid var(--border)",
                            borderRadius: "8px",
                            background: "var(--background)",
                            boxShadow: "0 10px 24px rgba(0, 0, 0, 0.35)",
                        },
                    }),
                ] : []),

                tray.stack([
                    sectionTitle("Поиск релиза"),
                    tray.flex([
                        tray.input("Название аниме", {
                            fieldRef: searchQuery,
                            style: { flex: "1", minWidth: "0" },
                        }),
                        tray.button("Найти", {
                            intent: "primary",
                            size: "sm",
                            loading: isSearching.get(),
                            onClick: ctx.eventHandler("search-btn", () => {
                                const q = (searchQuery.current || "").trim()
                                if (!q) {
                                    searchError.set("Введите название для поиска.")
                                    tray.update()
                                    return
                                }
                                isSearching.set(true)
                                searchResults.set([])
                                searchError.set("")
                                tray.update()
                                apiSearch(q)
                                    .then(res => {
                                        searchResults.set(res.slice(0, 8))
                                        searchError.set(res.length ? "" : "Ничего не найдено.")
                                        isSearching.set(false)
                                        tray.update()
                                    })
                                    .catch((e) => {
                                        const message = e && e.message ? e.message : "Проверьте разрешение networkAccess для aniliberty.top."
                                        searchError.set(message)
                                        isSearching.set(false)
                                        ctx.toast.error(message)
                                        tray.update()
                                    })
                            }),
                        }),
                    ], { gap: 8, direction: "row", style: { width: "100%" } }),
                    ...(err ? [tray.text(err, { style: { color: "var(--danger)", fontSize: "12px" } })] : []),
                    ...(resultItems.length > 0 ? [tray.stack(resultItems, { gap: 6 })] : []),
                ], { gap: 8, style: { paddingTop: "4px" } }),

                tray.stack([
                    sectionTitle("Отслеживаемые релизы", String(releases.length)),
                    tray.stack(releaseItems, { gap: 6 }),
                ], { gap: 8 }),

            ], { gap: 14, style: { padding: "12px" } })
        })
    })
}
