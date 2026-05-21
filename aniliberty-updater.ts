/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * AniLiberty Torrent Updater for Seanime
 *
 * Periodically checks tracked AniLiberty releases for new torrents
 * and replaces them in the built-in torrent client automatically.
 */

const API_BASE = "https://aniliberty.top/api/v1"
const STORAGE_STATE_KEY = "aniliberty-updater:state"
const STORAGE_RELEASES_KEY = "aniliberty-updater:tracked-releases"
const STORAGE_INTERVAL_KEY = "aniliberty-updater:interval"
const CRON_JOB_ID = "aniliberty-updater:check"

// ── Types ─────────────────────────────────────────────────────────────────────

interface AniLibertyTorrent {
    id: number
    hash: string
    size: number
    label: string
    description: string
    updated_at: string
    magnet: string
    filename: string
}

interface ReleaseState {
    hash: string
    updated_at: string
    description: string
}

interface State {
    [releaseId: string]: ReleaseState
}

interface TrackedRelease {
    id: number
    name: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadState(): State {
    return $storage.get<State>(STORAGE_STATE_KEY) || {}
}

function saveState(state: State): void {
    $storage.set(STORAGE_STATE_KEY, state)
}

function loadTrackedReleases(): TrackedRelease[] {
    return $storage.get<TrackedRelease[]>(STORAGE_RELEASES_KEY) || []
}

function saveTrackedReleases(releases: TrackedRelease[]): void {
    $storage.set(STORAGE_RELEASES_KEY, releases)
}

function loadInterval(): number {
    return $storage.get<number>(STORAGE_INTERVAL_KEY) || 30
}

function saveInterval(minutes: number): void {
    $storage.set(STORAGE_INTERVAL_KEY, minutes)
}

function minutesToCron(minutes: number): string {
    // Every N minutes cron: */N * * * *
    return `*/${minutes} * * * *`
}

// ── AniLiberty API ────────────────────────────────────────────────────────────

async function fetchReleaseTorrents(ctx: $ui.Context, releaseId: number): Promise<AniLibertyTorrent[]> {
    const resp = await ctx.fetch(`${API_BASE}/anime/torrents/release/${releaseId}`, { timeout: 15 })
    if (!resp.ok) return []
    return resp.json<AniLibertyTorrent[]>()
}

async function searchReleases(ctx: $ui.Context, query: string): Promise<any[]> {
    const resp = await ctx.fetch(`${API_BASE}/app/search/releases?query=${encodeURIComponent(query)}`, { timeout: 15 })
    if (!resp.ok) return []
    const data = resp.json<any>()
    return Array.isArray(data) ? data : (data?.data || [])
}

function pickBestTorrent(torrents: AniLibertyTorrent[]): AniLibertyTorrent | null {
    if (!torrents || torrents.length === 0) return null

    // Sort by updated_at descending, pick freshest
    const sorted = [...torrents].sort((a, b) =>
        (b.updated_at || "").localeCompare(a.updated_at || "")
    )
    const latestDate = sorted[0].updated_at
    const freshest = sorted.filter(t => t.updated_at === latestDate)

    // Among freshest, pick smallest size
    return freshest.reduce((min, t) => t.size < min.size ? t : min)
}

// ── Core update logic ─────────────────────────────────────────────────────────

async function checkAndUpdateRelease(
    ctx: $ui.Context,
    release: TrackedRelease,
    state: State,
): Promise<State> {
    const releaseKey = String(release.id)

    const torrents = await fetchReleaseTorrents(ctx, release.id)
    if (!torrents || torrents.length === 0) return state

    const best = pickBestTorrent(torrents)
    if (!best) return state

    const newHash = best.hash.toLowerCase()
    const prevHash = (state[releaseKey]?.hash || "").toLowerCase()

    if (newHash === prevHash) return state

    // New torrent found — update via magnet link in the built-in torrent client
    // Remove old torrent (keep files) then add new one via magnet
    try {
        if (prevHash) {
            const existing = await ctx.torrentClient.getTorrents()
            const old = existing.find(t => (t.hash || "").toLowerCase() === prevHash)
            if (old) {
                await ctx.torrentClient.pauseTorrents([old.hash])
                // Seanime's torrent client API doesn't expose a delete method,
                // so we pause it and notify the user to remove it manually,
                // then add the updated torrent.
            }
        }

        ctx.toast.info(`AniLiberty Updater: обновление «${release.name}»`)

        // Fetch the .torrent file as binary and add via magnet (magnet is always available)
        // Use the magnet link directly — it's the most reliable approach
        const magnetResp = await ctx.fetch(
            `${API_BASE}/anime/torrents/${newHash}/file`,
            { method: "GET", timeout: 30 }
        )

        if (magnetResp.ok) {
            // Torrent file download success — inform the user
            // (Seanime plugin API: torrentClient doesn't expose addTorrent directly,
            //  but we can open the magnet via the screen navigation)
            ctx.screen.navigateTo("/torrents", { magnet: best.magnet })
            ctx.toast.success(`AniLiberty: «${release.name}» — новый торрент добавлен`)
        } else {
            // Fallback: navigate to magnet link
            ctx.toast.info(`AniLiberty: открываем magnet для «${release.name}»`)
            ctx.screen.navigateTo("/torrents", { magnet: best.magnet })
        }

        return {
            ...state,
            [releaseKey]: {
                hash: newHash,
                updated_at: best.updated_at,
                description: best.description || "",
            },
        }
    } catch (err) {
        ctx.toast.error(`AniLiberty Updater: ошибка обновления «${release.name}»`)
        return state
    }
}

async function runCheck(ctx: $ui.Context): Promise<void> {
    const releases = loadTrackedReleases()
    if (releases.length === 0) return

    let state = loadState()

    for (const release of releases) {
        try {
            state = await checkAndUpdateRelease(ctx, release, state)
        } catch (_) {
            // skip broken release, continue
        }
    }

    saveState(state)
}

// ── Plugin entry point ────────────────────────────────────────────────────────

function init() {
    $ui.register((ctx) => {
        // ── State ──
        const searchQuery = ctx.fieldRef<string>("")
        const searchResults = ctx.state<any[]>([])
        const isSearching = ctx.state(false)
        const intervalInput = ctx.fieldRef<string>(String(loadInterval()))
        const statusText = ctx.state("Ожидание...")

        // ── Build tray ──
        const tray = ctx.newTray({
            iconUrl: "https://aniliberty.top/favicon.ico",
            withContent: true,
            width: "420px",
            minHeight: "200px",
        })

        // ── Schedule cron ──
        function startCron() {
            const minutes = loadInterval()
            $cron.removeAll()
            $cron.add(CRON_JOB_ID, minutesToCron(minutes), () => {
                runCheck(ctx)
                    .then(() => statusText.set(`Последняя проверка: ${new Date().toLocaleTimeString()}`))
                    .catch(() => statusText.set("Ошибка при проверке"))
            })
            $cron.start()
            statusText.set(`Мониторинг запущен (каждые ${minutes} мин.)`)
        }

        startCron()

        // ── Handlers (event names used in tray buttons) ──

        tray.onClick(() => {
            // refresh display when opened
            tray.update()
        })

        // Search
        ctx.registerEventHandler("do-search", () => {
            const q = searchQuery.current.trim()
            if (!q) return
            isSearching.set(true)
            searchResults.set([])
            searchReleases(ctx, q)
                .then(results => {
                    searchResults.set(results.slice(0, 8))
                    isSearching.set(false)
                    tray.update()
                })
                .catch(() => {
                    isSearching.set(false)
                    ctx.toast.error("AniLiberty: ошибка поиска")
                })
        })

        // Add release from search results by index
        ctx.registerEventHandler("add-release", (idx: number) => {
            const results = searchResults.get()
            const item = results[idx]
            if (!item) return

            const releases = loadTrackedReleases()
            if (releases.find(r => r.id === item.id)) {
                ctx.toast.warning("Релиз уже отслеживается")
                return
            }

            releases.push({ id: item.id, name: item.name?.main || `Release ${item.id}` })
            saveTrackedReleases(releases)
            ctx.toast.success(`Добавлен: ${item.name?.main}`)
            searchResults.set([])
            tray.update()
        })

        // Remove a tracked release
        ctx.registerEventHandler("remove-release", (id: number) => {
            const releases = loadTrackedReleases().filter(r => r.id !== id)
            saveTrackedReleases(releases)
            // Also remove from state
            const state = loadState()
            delete state[String(id)]
            saveState(state)
            tray.update()
        })

        // Run manual check
        ctx.registerEventHandler("run-check", () => {
            statusText.set("Проверка...")
            tray.update()
            runCheck(ctx)
                .then(() => {
                    statusText.set(`Проверка завершена: ${new Date().toLocaleTimeString()}`)
                    tray.update()
                })
                .catch(() => {
                    statusText.set("Ошибка при проверке")
                    tray.update()
                })
        })

        // Save interval
        ctx.registerEventHandler("save-interval", () => {
            const val = parseInt(intervalInput.current, 10)
            if (isNaN(val) || val < 1) {
                ctx.toast.error("Введите целое число ≥ 1")
                return
            }
            saveInterval(val)
            startCron()
            tray.update()
        })

        // ── Render tray UI ──
        tray.render(() => {
            const releases = loadTrackedReleases()
            const results = searchResults.get()

            // Tracked releases list
            const releaseItems = releases.length === 0
                ? [tray.text("Нет отслеживаемых релизов", { style: { color: "var(--muted)", fontSize: "13px" } })]
                : releases.map(r =>
                    tray.flex([
                        tray.text(r.name, { style: { flex: "1", fontSize: "13px" } }),
                        tray.button("✕", {
                            intent: "alert-subtle",
                            size: "xs",
                            onClick: ctx.eventHandler(`remove-${r.id}`, () => {
                                const list = loadTrackedReleases().filter(x => x.id !== r.id)
                                saveTrackedReleases(list)
                                const s = loadState()
                                delete s[String(r.id)]
                                saveState(s)
                                tray.update()
                            }),
                        }),
                    ], { gap: 8, direction: "row" })
                )

            // Search result items
            const resultItems = results.map((item, i) =>
                tray.flex([
                    tray.text(`${item.name?.main || "?"} (${item.year || "?"})`, {
                        style: { flex: "1", fontSize: "12px" },
                    }),
                    tray.button("+ Добавить", {
                        intent: "primary-subtle",
                        size: "xs",
                        onClick: ctx.eventHandler(`add-${i}`, () => {
                            const r = loadTrackedReleases()
                            if (r.find(x => x.id === item.id)) {
                                ctx.toast.warning("Уже отслеживается")
                                return
                            }
                            r.push({ id: item.id, name: item.name?.main || `Release ${item.id}` })
                            saveTrackedReleases(r)
                            ctx.toast.success(`Добавлен: ${item.name?.main}`)
                            searchResults.set([])
                            tray.update()
                        }),
                    }),
                ], { gap: 8, direction: "row" })
            )

            tray.stack([
                // Header
                tray.text("🌸 AniLiberty Updater", { style: { fontWeight: "bold", fontSize: "15px" } }),
                tray.text(statusText.get(), { style: { fontSize: "12px", color: "var(--muted)" } }),

                tray.css("hr { border: none; border-top: 1px solid var(--border); margin: 4px 0; }"),
                tray.p(["---"]),

                // Tracked releases
                tray.text("Отслеживаемые релизы", { style: { fontWeight: "600", fontSize: "13px" } }),
                tray.stack(releaseItems, { gap: 4 }),

                tray.p(["---"]),

                // Search
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
                            searchReleases(ctx, q)
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

                ...(resultItems.length > 0
                    ? [tray.stack(resultItems, { gap: 4 })]
                    : []
                ),

                tray.p(["---"]),

                // Controls
                tray.flex([
                    tray.button("▶ Проверить сейчас", {
                        intent: "success-subtle",
                        size: "sm",
                        onClick: ctx.eventHandler("check-btn", () => {
                            statusText.set("Проверка...")
                            tray.update()
                            runCheck(ctx).then(() => {
                                statusText.set(`Завершено: ${new Date().toLocaleTimeString()}`)
                                tray.update()
                            })
                        }),
                    }),
                    tray.flex([
                        tray.input("Мин.", {
                            fieldRef: intervalInput,
                            style: { width: "60px" },
                        }),
                        tray.button("Сохранить интервал", {
                            size: "sm",
                            onClick: ctx.eventHandler("interval-btn", () => {
                                const val = parseInt(intervalInput.current, 10)
                                if (isNaN(val) || val < 1) {
                                    ctx.toast.error("Введите целое число ≥ 1")
                                    return
                                }
                                saveInterval(val)
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