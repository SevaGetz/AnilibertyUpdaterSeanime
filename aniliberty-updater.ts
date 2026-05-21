/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * AniLiberty Torrent Updater for Seanime
 *
 * UI context runs in an isolated runtime — ALL helpers must be defined
 * inside $ui.register, not in the global scope.
 */

function init() {
    $ui.register((ctx) => {

        // ── Constants (must live inside register) ──────────────────────────────
        const API_BASE            = "https://aniliberty.top/api/v1"
        const KEY_STATE           = "aniliberty-updater:state"
        const KEY_RELEASES        = "aniliberty-updater:tracked-releases"
        const KEY_INTERVAL        = "aniliberty-updater:interval"
        const CRON_ID             = "aniliberty-updater:check"

        // ── Storage helpers ────────────────────────────────────────────────────
        function loadState(): Record<string, any> {
            return $storage.get(KEY_STATE) || {}
        }
        function saveState(s: Record<string, any>): void {
            $storage.set(KEY_STATE, s)
        }
        function loadReleases(): Array<{ id: number, name: string }> {
            return $storage.get(KEY_RELEASES) || []
        }
        function saveReleases(r: Array<{ id: number, name: string }>): void {
            $storage.set(KEY_RELEASES, r)
        }
        function loadInterval(): number {
            return $storage.get(KEY_INTERVAL) || 30
        }
        function saveInterval(m: number): void {
            $storage.set(KEY_INTERVAL, m)
        }

        // ── Torrent selection ──────────────────────────────────────────────────
        function pickBest(torrents: any[]): any | null {
            if (!torrents || torrents.length === 0) return null
            const sorted = torrents.slice().sort((a: any, b: any) =>
                (b.updated_at || "").localeCompare(a.updated_at || "")
            )
            const latestDate = sorted[0].updated_at
            const freshest = sorted.filter((t: any) => t.updated_at === latestDate)
            return freshest.reduce((min: any, t: any) => t.size < min.size ? t : min)
        }

        // ── AniLiberty API ─────────────────────────────────────────────────────
        async function fetchTorrents(releaseId: number): Promise<any[]> {
            const resp = await ctx.fetch(
                `${API_BASE}/anime/torrents/release/${releaseId}`,
                { timeout: 15 }
            )
            if (!resp.ok) return []
            return resp.json() || []
        }

        async function searchReleases(query: string): Promise<any[]> {
            const resp = await ctx.fetch(
                `${API_BASE}/app/search/releases?query=${encodeURIComponent(query)}`,
                { timeout: 15 }
            )
            if (!resp.ok) return []
            const data = resp.json()
            return Array.isArray(data) ? data : (data && data.data ? data.data : [])
        }

        // ── Update logic ───────────────────────────────────────────────────────
        async function checkRelease(
            release: { id: number, name: string },
            state: Record<string, any>
        ): Promise<Record<string, any>> {
            const key = String(release.id)
            const torrents = await fetchTorrents(release.id)
            const best = pickBest(torrents)
            if (!best) return state

            const newHash = (best.hash || "").toLowerCase()
            const prevHash = ((state[key] && state[key].hash) || "").toLowerCase()
            if (newHash === prevHash) return state

            // Pause old torrent if found in client
            if (prevHash) {
                try {
                    const existing = await ctx.torrentClient.getTorrents()
                    const old = existing.find((t: any) => (t.hash || "").toLowerCase() === prevHash)
                    if (old) {
                        await ctx.torrentClient.pauseTorrents([old.hash])
                    }
                } catch (_) {}
            }

            ctx.toast.info("AniLiberty: обновление «" + release.name + "»")
            ctx.screen.navigateTo("/torrents", { magnet: best.magnet })
            ctx.toast.success("AniLiberty: «" + release.name + "» — новый торрент")

            const newState = JSON.parse(JSON.stringify(state))
            newState[key] = {
                hash: newHash,
                updated_at: best.updated_at || "",
                description: best.description || "",
            }
            return newState
        }

        async function runCheck(): Promise<void> {
            const releases = loadReleases()
            if (releases.length === 0) return
            let state = loadState()
            for (let i = 0; i < releases.length; i++) {
                try {
                    state = await checkRelease(releases[i], state)
                } catch (_) {}
            }
            saveState(state)
        }

        // ── Cron ──────────────────────────────────────────────────────────────
        function startCron(): void {
            const minutes = loadInterval()
            $cron.removeAll()
            $cron.add(CRON_ID, "*/" + minutes + " * * * *", () => {
                runCheck()
                    .then(() => statusText.set("Последняя проверка: " + new Date().toLocaleTimeString()))
                    .catch(() => statusText.set("Ошибка при проверке"))
            })
            $cron.start()
            statusText.set("Мониторинг запущен (каждые " + minutes + " мин.)")
        }

        // ── UI state ───────────────────────────────────────────────────────────
        const searchQuery   = ctx.fieldRef("")
        const intervalInput = ctx.fieldRef(String(loadInterval()))
        const searchResults = ctx.state<any[]>([])
        const isSearching   = ctx.state(false)
        const statusText    = ctx.state("Ожидание...")

        // ── Tray ───────────────────────────────────────────────────────────────
        const tray = ctx.newTray({
            iconUrl: "https://aniliberty.top/favicon.ico",
            withContent: true,
            width: "420px",
            minHeight: "200px",
        })

        // Start cron on load
        startCron()

        // ── Render ─────────────────────────────────────────────────────────────
        tray.render(() => {
            const releases = loadReleases()
            const results  = searchResults.get()

            // Tracked releases list
            const releaseItems = releases.length === 0
                ? [tray.text("Нет отслеживаемых релизов", { style: { color: "var(--muted)", fontSize: "13px" } })]
                : releases.map((r) =>
                    tray.flex([
                        tray.text(r.name, { style: { flex: "1", fontSize: "13px" } }),
                        tray.button("✕", {
                            intent: "alert-subtle",
                            size: "xs",
                            onClick: ctx.eventHandler("rm-" + r.id, () => {
                                saveReleases(loadReleases().filter(x => x.id !== r.id))
                                const s = loadState()
                                delete s[String(r.id)]
                                saveState(s)
                                tray.update()
                            }),
                        }),
                    ], { gap: 8, direction: "row" })
                )

            // Search results
            const resultItems = results.map((item: any, i: number) =>
                tray.flex([
                    tray.text(
                        (item.name && item.name.main ? item.name.main : "?") + " (" + (item.year || "?") + ")",
                        { style: { flex: "1", fontSize: "12px" } }
                    ),
                    tray.button("+ Добавить", {
                        intent: "primary-subtle",
                        size: "xs",
                        onClick: ctx.eventHandler("add-" + i, () => {
                            const list = loadReleases()
                            if (list.find(x => x.id === item.id)) {
                                ctx.toast.warning("Уже отслеживается")
                                return
                            }
                            list.push({ id: item.id, name: item.name && item.name.main ? item.name.main : "Release " + item.id })
                            saveReleases(list)
                            ctx.toast.success("Добавлен: " + (item.name && item.name.main ? item.name.main : item.id))
                            searchResults.set([])
                            tray.update()
                        }),
                    }),
                ], { gap: 8, direction: "row" })
            )

            tray.stack([
                tray.text("🌸 AniLiberty Updater", { style: { fontWeight: "bold", fontSize: "15px" } }),
                tray.text(statusText.get(), { style: { fontSize: "12px", color: "var(--muted)" } }),

                tray.p(["─────────────────────────"]),

                tray.text("Отслеживаемые релизы", { style: { fontWeight: "600", fontSize: "13px" } }),
                tray.stack(releaseItems, { gap: 4 }),

                tray.p(["─────────────────────────"]),

                tray.text("Добавить релиз", { style: { fontWeight: "600", fontSize: "13px" } }),
                tray.flex([
                    tray.input("Поиск...", { fieldRef: searchQuery, style: { flex: "1" } }),
                    tray.button("Найти", {
                        intent: "primary",
                        size: "sm",
                        loading: isSearching.get(),
                        onClick: ctx.eventHandler("search-btn", () => {
                            const q = searchQuery.current.trim()
                            if (!q) return
                            isSearching.set(true)
                            searchResults.set([])
                            tray.update()
                            searchReleases(q)
                                .then(res => {
                                    searchResults.set(res.slice(0, 8))
                                    isSearching.set(false)
                                    tray.update()
                                })
                                .catch(() => {
                                    isSearching.set(false)
                                    tray.update()
                                })
                        }),
                    }),
                ], { gap: 6, direction: "row" }),

                ...(resultItems.length > 0 ? [tray.stack(resultItems, { gap: 4 })] : []),

                tray.p(["─────────────────────────"]),

                tray.flex([
                    tray.button("▶ Проверить сейчас", {
                        intent: "success-subtle",
                        size: "sm",
                        onClick: ctx.eventHandler("check-btn", () => {
                            statusText.set("Проверка...")
                            tray.update()
                            runCheck()
                                .then(() => {
                                    statusText.set("Завершено: " + new Date().toLocaleTimeString())
                                    tray.update()
                                })
                                .catch(() => {
                                    statusText.set("Ошибка")
                                    tray.update()
                                })
                        }),
                    }),
                    tray.flex([
                        tray.input("Мин.", { fieldRef: intervalInput, style: { width: "60px" } }),
                        tray.button("Сохранить", {
                            size: "sm",
                            onClick: ctx.eventHandler("interval-btn", () => {
                                const val = parseInt(intervalInput.current, 10)
                                if (isNaN(val) || val < 1) {
                                    ctx.toast.error("Введите целое число ≥ 1")
                                    return
                                }
                                saveInterval(val)
                                intervalInput.setValue(String(val))
                                startCron()
                                tray.update()
                            }),
                        }),
                    ], { gap: 4, direction: "row" }),
                ], { gap: 8, direction: "row" }),

            ], { gap: 8 })
        })
    })
}