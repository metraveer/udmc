# Проверка клиента при входе: принятое решение

Этот документ — результат исследования, проведённого после того, как проверка клиента
четыре раза подряд ломалась на реальных сборках. Он записан как есть, вместе с разбором
отвергнутых вариантов, чтобы решение не пришлось принимать заново.

**Главное следствие для планирования: UDMC не может поддерживать Minecraft ниже 1.20.2.**
Механизм, на котором держится проверка, появился именно там. Подробно и с проверкой:
`docs/supported-minecraft-versions.md`.

Ниже — исходный текст исследования на английском, языке кода и документации загрузчиков.

---

# DECISION: move the check to the configuration phase, with a dependency-free transport on Fabric and NeoForge's own payload API on NeoForge

---

## 1. THE VERDICT

**Phase: configuration, on all four build targets.** This is the single most consequential call, and all four research documents converge on it independently: it is where Mojang put its own two "ask, inspect, reject with a Component" mechanisms (`ServerResourcePackConfigurationTask` in 1.21.1, `ServerCodeOfConductConfigurationTask` in 26.2), where both loaders put theirs (`CheckFeatureFlags`, Fabric's register/ping barrier), and where every mod that used to do this in the login phase (owo-lib, Fabwork, Polymer) moved in 1.20.2. The login phase has no vanilla support at all — `handleCustomQueryPacket` is literally `disconnect(DISCONNECT_UNEXPECTED_QUERY)` — which is precisely why Fabric API had to seize it winner-takes-all and why UDMC has now lost four times there.

**Transport: yes, two adapters. Say it plainly.**

| Target | Codec / transport | Ask point | Gate | Verdict |
|---|---|---|---|---|
| **Fabric 1.21.1 / 26.1.2 / 26.2**, Fabric API present or absent | own mixin on `DiscardedPayload.codec` + HEAD mixins on `ServerCommonPacketListenerImpl.handleCustomPayload` and `ClientCommonPacketListenerImpl.handleCustomPayload`; transmit with `connection.send` | `ServerConfigurationPacketListenerImpl.startConfiguration` HEAD | answer, or `handleConfigurationFinished` HEAD, or tick deadline — first wins | `listener.disconnect(Component)` before world entry |
| **NeoForge 21.1.248 / 1.21.1** | `PayloadRegistrar.optional().configurationToClient/ToServer` + `IPayloadContext` | `RegisterConfigurationTasksEvent` → `ICustomConfigurationTask` | answer, or `hasChannel == false` at task start, or tick deadline | same |

Everything above the transport is shared and unchanged: wire format, `Query`/`Answer`/`Decision`, `validate()`, `AgentLoginNotice`, `Messages`, both lang files, the `WeakHashMap<Connection, Decision>` warn map, `PlayerListMixin`, `DisconnectedScreenMixin`.

### Why this beats each alternative

**Why not bundle `fabric-networking-api-v1` (design 1).** Three reasons, in order of weight.
1. It converts configuration (b) — "Fabric, no Fabric API", the one case 0.18.0 gets *right* — from tested-clean into "now runs Fabric's entire networking mixin set, including `removeLateCompressionPacketSending`, the redirect that caused failure #4." That is a risk transfer with no compensating benefit, because the mixin transport is verified to work identically in both worlds.
2. ~205–225 KB on every nested jar, on a file every player downloads, plus the newest-wins hoisting hazard: loader picks the higher version among equally-nested candidates, so UDMC's copy can be hoisted above the rest of a pack's older Fabric API, with no `breaks`/`conflicts` to catch it and — confirmed — **invisible to UDMC's own diagnostics**, since `ModMetadata` only counts non-nested roots.
3. As written it does not compile (`getOwner()` is on `ServerCommonPacketListenerImpl`, not on the `ServerConfigurationPacketListener` interface NeoForge hands you), and its `addTask`/`completeTask` route needs an explicit cast on 26.x because that module ships a classtweaker rather than `loom:injected_interfaces` and is pulled as plain `implementation`. Both fixable, but they are symptoms of buying a dependency for machinery we do not need: the finish-packet barrier gives the same guarantee with zero coordination.

**Why not login cookies (design 3).** The mechanism is genuinely clean — cookies are uncontested by Fabric API (0 hits across all 92 nested modules of both lines) and NeoForge (0 hits across 764 patches), a modless client *positively* answers `null` in one round trip, and it is a net −45 lines. But it bets the release on one thing nobody measured: **Velocity treats cookies as a proxy-owned abstraction** (`Player#storeCookie` / `requestCookie`), so a backend cookie request during login is exactly the packet a proxy is architecturally motivated to answer itself. Design 3's own argument here is inverted — login *plugin messages* are the mechanism Velocity's modern forwarding is built on and must forward faithfully; login *cookies* are the newer, proxy-owned thing. And even if it survives, it leaves UDMC in the login phase with the 30 s `slow_login` wall, the compression transition, a dead protocol Mojang deprecated in 1.20.2, and no loader API on either side — i.e. one Fabric API refactor away from attempt #5. It also needs the *same* transitional client release as the configuration move, so it does not even buy a cheaper migration.

**Why NeoForge gets its own transport rather than sharing Fabric's mixins.** This is not aesthetic. On NeoForge, an unregistered payload that decodes into our own type is `isModdedPayload == true` (the exclusion is `!(payload instanceof DiscardedPayload)`), which reaches `NetworkRegistry.handleModdedPayload` → **`disconnect("NeoForge %s (No Channel for udmc_sync:verify_query)")`**. So on NeoForge the mixin transport's correctness rests entirely on winning a HEAD race, and *losing means a hard kick with NeoForge's wording* — the exact failure class that started this saga. Add: `getCodec` emits `"No registration for payload …; refusing to decode"` on every encode *and* decode (`findCodec` serves `writeCap` too), i.e. 4–5 WARN lines per join; and `connection.send` only works because `checkPacket` today lives in the two listener `send` methods and not in `Connection` — a one-line NeoForge change away from breaking. NeoForge's API costs nothing (it is in the loader, no bundled jar, no hoisting), gives `hasChannel` for free, and runs handlers on the main thread automatically (`HandlerThread.MAIN` wraps every handler in `MainThreadPayloadHandler` → `enqueueWork`). Take it.

**Two channel ids, not one — verified, and it constrains the design.** `NetworkRegistry.register` throws `UnsupportedOperationException("… as it is already registered")` on a duplicate id within the same `ConnectionProtocol`, and `configurationToClient`/`configurationToServer` both write into the `CONFIGURATION` map. So: `udmc_sync:verify_query` (S2C) and `udmc_sync:verify_answer` (C2S), two payload records, on **both** loaders so the wire is identical.

---

## 2. WHY THE FOUR MEASURED FAILURES CANNOT RECUR

**#1 — cancel-and-wait: with Fabric API the client never receives the question.** Cause: `ClientboundCustomQueryPacketMixin` does `cir.setReturnValue(new FriendlyByteBufLoginQueryRequestPayload(...))` at `readPayload` HEAD **for every channel, no discriminator, default priority 1000**, so it is a coin flip and Fabric wins. We no longer send a login query, so there is nothing for it to steal. In the configuration/play lane Fabric's equivalent hook is `CustomPayloadStreamCodecMixin`, a MixinExtras `@WrapOperation` on `findCodec` that ends `return original.call(fallback, id)` — it **composes**; NeoForge's is a source patch that likewise falls through to `create(id)`. That asymmetry between the two lanes is the whole reason this works.

**#2 — priority 500: answer read correctly, `verifyLoginAndFinishConnectionSetup` never re-entered.** Cause: `ConnectionMixin.checkPacket` → `PacketCallbackListener.sent` → `ServerLoginPacketListenerImplMixin.sent`, which books **any** `ClientboundCustomQueryPacket` into `channels`; `queryTick()` returns `channels.isEmpty() && waits.isEmpty()`, and Fabric's `@Redirect` on `tick()`'s call to `verifyLoginAndFinishConnectionSetup` gates on it. We send no `ClientboundCustomQueryPacket`, so `channels` stays empty and the gate opens on its first call. Confirmed: the only implementors of `PacketCallbackListener` are the two **login** listener mixins; `ServerConfigurationNetworkAddon` has no `channels` map, no `registerOutgoingPacket`, no `sent`. A raw `ClientboundCustomPayloadPacket` during configuration incurs zero Fabric bookkeeping.

**#3 — ask at `handleHello` TAIL, decide at `placeNewPlayer` TAIL: hangs with Fabric API.** Same two causes as #1 and #2 compounded. Additionally, the new design depends on no login-state re-entrancy whatsoever: the gate is a packet the client is *required* to send (`ServerboundFinishConfigurationPacket`), not a method vanilla happens to call again while `state == VERIFYING`.

**#4 — "Badly compressed packet - size of 2 is below server threshold of 256".** Cause: Fabric's `@Redirect` on `getCompressionThreshold()` **scoped to `verifyLoginAndFinishConnectionSetup`** strips vanilla's compression packet and re-sends it from `queryTick()`, so the switch lands on opposite sides of your query depending on whether Fabric API is present; the server flips its inbound decoder with `validateDecompressed = true` while the client is still writing uncompressed, and "size 2" is literally `SERVERBOUND_CUSTOM_QUERY_ANSWER`'s packet id read as a frame-length header. Configuration begins in `handleLoginAcknowledgement`, strictly after `ClientboundLoginCompressionPacket` and `ClientboundGameProfilePacket`; **there is no compression or encryption transition anywhere inside the configuration phase** — only protocol swaps, which are frame-transparent. Structurally impossible.

**Bonus retired:** the 600-tick `slow_login` wall (`MAX_TICKS_BEFORE_LOGIN = 600`, confirmed identical in 1.21.1, 26.1.2, 26.2) does not exist in configuration; `keepConnectionAlive()` keeps both the 15 s keep-alive and netty's `ReadTimeoutHandler(30)` fed. Our own deadline replaces it.

---

## 3. VERIFY BEFORE WRITING CODE

Eight checks. Items 1–3 are the ones that cost a release cycle if wrong.

1. **No `checkcast DiscardedPayload` reachable from the codec path** — the one lie in the Fabric transport. Run over all three MC jars *and* Fabric API 4.3.1 / 6.3.1 / 6.3.3:
   ```bash
   for j in mc1211 mc2612 mc262 net1211 net262; do
     find "$j" -name '*.class' -exec javap -c -p {} + 2>/dev/null \
       | grep -n "checkcast.*DiscardedPayload" && echo "HIT in $j"
   done
   ```
   Expect zero. The one `instanceof` at `ClientCommonPacketListenerImpl.handleCustomPayload` and NeoForge's `isModdedPayload` are fine. Note `CustomPacketPayload$1.decode` ends `checkcast CustomPacketPayload`, not the narrow type, and `setReturnValue` can only emit a cast to `StreamCodec` because the descriptor is erased — so this check is the whole gate. **Make it a permanent Gradle `check` task**, not a one-off.

2. **`DiscardedPayload.codec` descriptor per version** — one line each:
   ```bash
   javap -p -cp <mcjar> net.minecraft.network.protocol.common.custom.DiscardedPayload | grep codec
   ```
   Expect `public static <T extends FriendlyByteBuf> StreamCodec<T,DiscardedPayload> codec(ResourceLocation|Identifier, int)`.

3. **Compile all three Fabric variants** before anything else, to prove Mixin accepts `@Inject(method="codec")` on a static with a raw `CallbackInfoReturnable<StreamCodec>` under each Loom mapping set, and that `@Shadow @Final protected Connection connection` / `protected MinecraftServer server` resolve on `ServerCommonPacketListenerImpl` and `ClientCommonPacketListenerImpl` (`"injectors": {"defaultRequire": 1}` turns a miss into a hard crash, not a warning).

4. **NeoForge two-id requirement** — already confirmed here: `NetworkRegistry.java:176` `if (byProtocol.containsKey(type.id())) throw new UnsupportedOperationException("… already registered")`, and both configuration methods write into `ConnectionProtocol.CONFIGURATION`. Re-check against whatever NeoForge you ship.

5. **NeoForge `hasChannel` for a non-Neo client.** `NetworkRegistry.hasChannel` (line 597) falls back to `ChannelAttributes.getOrCreateAdHocChannels(connection)`, populated from `MinecraftRegisterPayload`, which a Fabric client sends before it pongs — and `RegisterConfigurationTasksEvent` fires from `addOptionalTasks()`, downstream of `handlePong(0)`. Reasoning says it is true by then; **confirm on the stand**, because a false negative tells a correctly-installed player "not installed".

6. **The reconfigure question.** `javap -c` on `ServerGamePacketListenerImpl.handleConfigurationAcknowledged` in all three versions: it constructs a new listener and returns at offset 54 **without** calling `startConfiguration`. I believe this is a non-issue and disagree with the design-2 critique on it: reconfigure is reachable only from play, which is reachable only through the gate on the same `Connection`, so nothing is bypassed — and `takeWarning` is a `remove`, so no duplicate notice. Verify the bytecode, then add a one-line DEBUG log if `handleConfigurationFinished` ever runs on a connection we never asked.

7. **`minecraft-protocol@1.66.2` drives configuration-state `custom_payload` both ways on 1.21.1** — one node round-trip before rewriting the E2E. `minecraft-data`'s `configuration.toClient`/`toServer` both list `custom_payload` and `finish_configuration`; prove it end to end.

8. **Fabric API for 26.1.2 does not exist on this machine.** Fetch `fabric-api 0.155.2+26.1.2`, unpack `META-INF/jars/fabric-networking-api-v1-6.3.1+554860db4c.jar`, and re-run two greps: that `CustomPayloadStreamCodecMixin` still ends in `original.call(fallback, id)`, and that `ServerCommonPacketListenerImplMixin.handleCustomPayloadReceivedAsync` still cancels **conditionally**. 26.1.2 is the only line where nothing has ever been executed.

While you are in there, confirm the two known-stale facts: `scripts/runtime-agent-check.js:106` asserts `/agents/install` while `AgentDistribution.instructionsUrl()` returns `serverUrl + "/udmc"` (it cannot pass), and `package.json`'s `npm test` does not run that script at all — so the protocol E2E has been silently absent from CI.

---

## 4. IMPLEMENTATION PLAN

### Wire format (unchanged bytes, new channels)
```
udmc_sync:verify_query   S2C config:  varint protocol, utf(64) packId, utf(64) clientHash, utf(2048) downloadUrl, bool required
udmc_sync:verify_answer  C2S config:  varint protocol, utf(64) packId, utf(32) version,    utf(64) jarHash
udmc_sync:verify_project S2C config:  varint protocol, utf(64) packId, utf(128) packName, utf(2048) apiUrl, utf(256) publicKey
```
Keeping the field layout byte-identical lets the E2E reuse its protodef containers verbatim. `TRANSACTION_ID` is deleted. Serverbound configuration cap is 32 767 bytes; our answer is ~200.

**Why a third channel rather than more fields on the question (0.20).** With one mod for
everybody, a client arrives knowing nothing and has to be told which project it just joined.
That could have been extra fields on `verify_query` — but clients from 0.19.0 decode that
payload by position, and Minecraft refuses a payload whose buffer is not read to the end. A
longer question would break them mid-handshake and cost them the very screen that explains
what to install. They do not know `verify_project` at all, so it decodes to `DiscardedPayload`
and is dropped, and they still reach the disconnect screen.

On NeoForge the same reasoning has teeth in the other direction: an unregistered payload is a
hard kick, so the server checks `hasChannel(UdmcProjectPayload.TYPE)` before sending it. A
client from before this channel simply never receives it.

**The two protocol numbers.** `QUERY_PROTOCOL` is frozen at 2 — it is what the server writes
into the question, and changing it would make 0.19.0 clients fall silent, which the server can
only report as "not installed". `PROTOCOL` is 3: what a client says about *itself*. A server on
3 therefore recognises a 2 and answers it with `udmc_sync.login.incompatible` instead of
silence. A client that belongs to no project yet answers with an empty `packId`, which is a
third case again: installed, current, and not yet set up.

### Step order

**Step 0 — the verification list above.** Do not skip; item 1 becomes a permanent build guard.

**Step 1 — shared core** (`udmc-sync-common`, no Minecraft networking types):
- `AgentLoginProtocol`: keep `Query`/`Answer`/`Decision`, `query()`, `answer(Query)`, `validate(Answer)`, `warn`/`takeWarning` **exactly as they are** — this is what keeps `AgentUpdateTest` and `LocalizationTest` compiling untouched. Add: `encodeQuery/decodeQuery/encodeAnswer/decodeAnswer`; a **memoized `Query`** invalidated by `AgentDistribution` on publish and by the `requireClientAgent` settings flip (so the question is never built from file I/O on a netty thread); and `clearServer()`, called when `api.start()` throws — today `configureServer` has already run by then and nothing ever unsets it, so a dead API keeps handing players a dead URL.
- New `UdmcVerification`: the state machine, keyed by `Connection` in a `WeakHashMap` beside `WARN`. Per connection: `asked`, `answered`, `decided` (all volatile — `startConfiguration` runs on the netty loop, `tick()` on the server thread, and the current `ServerLoginMixin` already marks its cross-thread fields volatile; losing that is a fail-*open* regression), a tick counter, and a `Gate`. **Three decision triggers, first wins:** the answer arrives; the gate/finish fires; the deadline (200 ticks ≈ 10 s) expires. Deciding on arrival means a bad client is rejected in one RTT, and the finish trigger means a clean vanilla client is rejected instantly instead of waiting out the deadline. All decisions hop to the server thread first.
- `Gate` interface: `release()` / `reject(Component)` / `onServerThread(Runnable)`.

**Step 2 — payloads** in the existing `src/network/{classic,modern}` (`ResourceLocation` vs `Identifier`, the split that already exists and that NeoForge shares): `UdmcQueryPayload` and `UdmcAnswerPayload`, both `implements CustomPacketPayload` with a `Type<>` and a `StreamCodec<FriendlyByteBuf, …>`. Same file names as today, new supertype.

**Step 3 — Fabric transport** (three mixins):
- `UdmcPayloadCodecMixin` (per-version, in `src/network/{classic,modern}`) — `@Inject` at `DiscardedPayload.codec` HEAD, `setReturnValue` for our two ids. Serves both encode and decode, both directions, both phases.
- `ServerPayloadMixin` / `ClientPayloadMixin` (common) — `@Inject(HEAD, cancellable)` on `handleCustomPayload` of `ServerCommonPacketListenerImpl` / `ClientCommonPacketListenerImpl` (the client one needs the explicit descriptor; the method is overloaded). **Set an explicit `priority` (1500)** — do not rely on load order where any competitor is a hard failure.
- `ServerConfigVerifyMixin` (common) on `ServerConfigurationPacketListenerImpl`: ask at `startConfiguration` HEAD (idempotent guard — Fabric re-enters this method from its register/pong pump); gate at `handleConfigurationFinished` HEAD with `if (!server.isSameThread()) return;` so vanilla's `ensureRunningOnSameThread` reschedules us onto the server thread; deadline at `tick()` HEAD.
- Transmit with `connection.send(new ClientboundCustomPayloadPacket(...))` / `ServerboundCustomPayloadPacket`.

**Step 4 — NeoForge transport** (`udmc-sync-neoforge`, ~110 lines, no mixins):
- On the mod bus, **unconditionally in both generated JARs** (server and client must declare identical channels or Neo↔Neo negotiation fails before our task runs): `event.registrar("1").optional().configurationToClient(QUERY, …).configurationToServer(ANSWER, …)`. The version literal `"1"` must never change — matched pairs are version-compared even when optional, and a mismatch produces NeoForge's own `multiplayer.disconnect.incompatible` instead of our notice. Carry protocol changes inside the payload.
- `RegisterConfigurationTasksEvent` → register an `ICustomConfigurationTask`: memory connection → finish; `!listener.hasChannel(QUERY_TYPE)` → decide immediately (no round trip); otherwise send and hold. Answer handler → `UdmcVerification.answered(...)` (already on the main thread thanks to `MainThreadPayloadHandler`) → `listener.finishCurrentTask(TYPE)` or `listener.disconnect(component)`.
- Deadline: reuse the shared `tick()` mixin (1.21.1 has no `ConfigurationTask.tick()`; that is 26.x-only).
- Warn delivery: `PlayerLoggedInEvent`, or keep `PlayerListMixin` as-is — prefer keeping `PlayerListMixin`, it already works and changing it changes nothing for the better.

**Step 5 — delete:** `ServerLoginMixin`, `ClientHandshakeMixin`, `ServerAnswerDecoderMixin`, `ClientQueryDecoderMixin` ×2, and the `login.custom` payload interfaces. **Keep:** `PlayerListMixin`, `DisconnectedScreenMixin`, `DedicatedServerMixin`, `MinecraftServerMixin`, `ClientTickMixin`.

**Step 6 — mixin configs.** File **names** unchanged, so `generator.rs::customize_jar` (lines 259–275) and its assertion at ~789 need **no edit** — it rewrites only the two hard-coded filenames, `environment`, `displayName`, and one entrypoint key.
```
udmc_sync.mixins.json         : DedicatedServerMixin, MinecraftServerMixin, ServerConfigVerifyMixin,
                                ServerPayloadMixin, PlayerListMixin, UdmcPayloadCodecMixin
udmc_sync.client.mixins.json  : ClientTickMixin, ClientPayloadMixin, DisconnectedScreenMixin,
                                UdmcPayloadCodecMixin
udmc_sync.neoforge.mixins.json: PlayerListMixin  |  client: DisconnectedScreenMixin
```
The Fabric-only classes stay in the jar on NeoForge, unapplied — same as `ServerLoginMixin` sits unapplied in client jars today.

**Step 7 — tests.** `AgentUpdateTest` and `LocalizationTest`: **no change** (they drive `AgentLoginProtocol` and the 11-field `Decision` directly, neither of which changes shape). `scripts/i18n.test.js`: its loop reads `ServerLoginMixin.java` and `PlayerListMixin.java` by name from one module root — repoint at `ServerConfigVerifyMixin.java` and `PlayerListMixin.java`, keep the `Component.literal(` ban, and add the static grep from step 0. `scripts/runtime-agent-check.js`: rewrite to configuration `custom_payload`, fix line 106 to `/udmc`, **and add it to `npm test`/CI** — it has never actually run.

**No new dependency. No new source set. No Gradle change (`resourceModules` untouched, so `PlatformDefaults.bundledMods()`, `ModMetadata.problems`, `LocalizationTest.checkPackagedResources` are all unaffected). No Rust change.** Net Java is roughly flat: ~−195 deleted, ~+230 added, and the protocol path goes from six contested mixins to three uncontested ones on Fabric and zero on NeoForge.

**Step 8 — migration, and this is the part to get right.** A 0.18 client answers only login queries; a 0.19 server asks only in configuration. So on upgrade every existing player reads as `missing` — "the UDMC client is not installed, download it from …" — for a client that is installed and merely old, and which needs *two* relaunches to heal (`AgentUpdater.checkClient` runs at client init; `schedule` swaps on the next launch). Note the scope precisely: on Fabric-API packs 0.18 was already broken, so nothing regresses; the damage lands on the no-Fabric-API setups that 0.18 got right. Do three things:
- On server-agent upgrade, **force `requireClientAgent = false`**, with a Control-app notice ("republish the client JAR, then re-enable").
- **Reword the `missing` fallback for exactly one release** to cover both causes: "not installed, or an older version — if you have just updated, restart the game once." Revert next release.
- Do **not** attempt a legacy login-query fallback. Confirmed fatal: `sent()` books any `ClientboundCustomQueryPacket` into Fabric's `channels`, and `queryTick()` then never releases `verifyLoginAndFinishConnectionSetup`. That escape hatch is closed, and design 1's server-side variant of it only exists because it bundles Fabric API — which we are not doing.

---

## 5. TEST PLAN ON THE REAL STAND

**Automated** (`scripts/runtime-agent-check.js`, 1.21.1 only — `minecraft-protocol@1.66.2` still has no 26.x support, per `docs/development.md:165`). Keep `assert.equal(events.joined, !reject)`; the configuration gate preserves "rejected before world entry". Scenarios:

| mode | client behaviour | must show |
|---|---|---|
| `current` | correct answer | joins, no notice |
| `outdated` | different version + hash | rejected, `login.restart` wording, **no** URL in the message |
| `rebuilt` | same version, different hash | rejected, `login.restart`, no URL |
| `other` | different packId, blank hash | rejected, message names this server's packId |
| `vanilla` | never registers, never answers | rejected **fast** (well under 1 s, via the finish trigger), message contains `/udmc` |
| `silent` | registers, then never answers and never finishes | rejected at ~10 s via the deadline |
| `late` | answers **after** `finish_configuration` | still rejected — fail-closed |
| `warn` | `requireClient:false` + `vanilla` | joins **and** receives a `system_chat` containing `open_url` |

**Native matrix** — one CDP screenshot of the disconnect screen per rejecting row (mandatory per `CLAUDE.md`; the "open page" / "copy link" buttons come from `DisconnectedScreenMixin` scraping `getNarrationMessage()` for `UDMC` + `https?://`, and no programmatic check covers them):

| # | server | client | must show |
|---|---|---|---|
| 1 | Fabric 1.21.1 **+ full Fabric API** | same + correct UDMC client | joins clean — **this is the case 0.18.0 gets wrong** |
| 2 | ″ | no UDMC mod | rejected instantly, bilingual text, both buttons |
| 3 | ″ | stock **vanilla** client, no loader | rejected, readable text, client log clean |
| 4 | Fabric 1.21.1, **no** Fabric API anywhere | correct client | joins clean — **the case 0.18.0 gets right; must not regress** |
| 5 | API on server only, then client only | correct client | joins clean both ways (asymmetric, never tested before) |
| 6 | any | UDMC of another project / stale hash / regenerated jar | `foreign` / `outdated` / `rebuilt`, both version lines present |
| 7 | Fabric **26.2** | rows 1–4 | same |
| 8 | Fabric **26.1.2** | rows 1–4 | same — nothing has ever run on this line |
| 9 | NeoForge 21.1.248 | Neo client with / without UDMC | same verdicts, **our** notice not NeoForge's; check for `getCodec` WARN lines (there should be none, since we register properly) |
| 10 | Fabric server with a **server resource pack** configured | client that must download it | verdict still lands before world entry; pack download uninterrupted; deadline does not fire early |
| 11 | any | client behind ~500 ms injected RTT (`clumsy`/`tc`) | answer still beats `finish_configuration`; deadline does not fire |
| 12 | any, behind **Velocity** and behind **BungeeCord** | correct client | joins clean — configuration payloads are the well-trodden proxy path, but prove it |
| 13 | 0.18 server ↔ 0.19 client, and 0.19 server ↔ 0.18 client | | the §Step-8 behaviour: forced warn-only, reworded message, heals after one restart |

Also assert on rows 1–3 that the verdict appears in the server log **before** `SynchronizeRegistriesTask`-related traffic on NeoForge is irrelevant (our task runs after it there) but on Fabric the finish-gate necessarily lands after registry sync — expected, and worth noting so nobody reads it as a bug.

---

## 6. RISKS AND OPEN QUESTIONS

**The disconnect screen title changes**, and this needs the owner's sign-off. Configuration rejection uses `ClientboundDisconnectPacket`, so the screen is titled `disconnect.lost` ("Connection Lost") instead of the login phase's `CommonComponents.CONNECT_FAILED` ("Failed to connect to the server"). The body — your notice, both bilingual fallbacks, the aqua link, the version block — is byte-identical, and both scrape-driven buttons still appear. Nothing in `LocalizationTest` asserts the title.

**The Fabric codec hook returns a `UdmcQueryPayload` from a method declared to return `StreamCodec<T, DiscardedPayload>.`** Erasure makes it work, and the scan says nothing casts. But it is a lie, and a future Mojang refactor that adds one `(DiscardedPayload)` cast breaks decode at runtime. The permanent build-guard task (verification item 1) is not optional — it is what makes this design safe to carry across version bumps.

**A future mod cancelling `handleCustomPayload` at HEAD ahead of us on Fabric.** Structurally the same hazard class as the login collision, but far weaker: the configuration/play lane is designed for many consumers and both loaders' hooks there are conditional. I found no mod doing an unconditional cancel. The explicit priority 1500 is the hedge. On NeoForge this hazard is removed entirely by using the payload registry.

**NeoForge on 26.x is out of scope and always was.** `minecraft/agent-catalog.json` has four targets: Fabric 1.21.1 / 26.1.2 / 26.2 and NeoForge 1.21.1. The stated constraint "must work on NeoForge on 26.x" is satisfied by neither this design nor the current one, because no such module exists. When it does, re-verify `RegisterPayloadHandlersEvent`, `PayloadRegistrar`, `RegisterConfigurationTasksEvent` and `IPayloadContext.finishCurrentTask` against it.

**26.1.2 remains inference, not inspection.** MC 26.1.2 is identical to 26.2 on every point this design touches (`DiscardedPayload.codec` descriptor, the same four referencing classes with zero casts, `ServerCommonPacketListenerImpl` fields and empty `handleCustomPayload`, the full `ServerConfigurationPacketListenerImpl` member list). Only the Fabric API 6.x module built for that line is unverified. Verification item 8 plus matrix row 8 close it.

**Vanilla clients on NeoForge are not unconditionally safe** — if the pack contains any *other* Neo mod with a non-optional payload, `initializeOtherConnection` disconnects the vanilla client from `handlePong(0)` with NeoForge's misleading "you are not running NeoForge" text, before our task ever runs. Not our bug, not fixable by us, but do not promise configuration (d) on NeoForge unconditionally.

**Configuration has no phase timeout, and that cuts both ways.** Our 200-tick deadline covers our own task; it cannot rescue a player stuck behind *another* mod's configuration task that never finishes. Serial task execution is a shared-fate property of the phase. Document it.

**Two things already broken in the tree, unrelated to this change but in its blast radius:** `runtime-agent-check.js` cannot pass (`/agents/install` vs `/udmc`) and is not in `npm test`; and `AgentLoginProtocol.server` is never cleared when `api.start()` throws, so a dead HTTP API keeps the check armed with a dead download URL. Fix both in this pass.

**One judgement where I disagree with a critique, stated so the maintainer can overrule me:** the "reconfiguration silently bypasses the check" finding. `handleConfigurationAcknowledged` indeed does not call `startConfiguration`, but reconfiguration is reachable only from the play phase, which is reachable only through the gate on the same `Connection` — so there is nothing to bypass, and `takeWarning`'s `remove` semantics prevent a duplicate notice. I recommend arming only at `startConfiguration` HEAD and adding a DEBUG log if the finish gate ever fires on a connection we never asked, rather than adding a second ask point on `returnToWorld`.