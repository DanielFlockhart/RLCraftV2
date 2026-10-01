# Minecraft player outputs: complete action reference

This is the action-space reference for MLCraft: **what a player can attempt to do**, rather than what the player can observe. It covers vanilla **Minecraft Java 1.18.1, protocol 757**, the project's current server baseline. It includes survival actions, every inventory click mode, workstation choices, client UI controls, and separately restricted creative/spectator/operator actions.

**This is a catalog, not a claim that every action is implemented.** The current policy API only exposes seven movement buttons, camera rotation, and digging. Everything else below is a possible extension. A valid action can still fail because of reach, game mode, permissions, cooldown, inventory, collision, world rules, or a changed target.

There cannot be a fixed universal list for every Minecraft version, mod and server plugin: their item registries, recipes, menus, commands and custom protocols extend the space. This reference covers the baseline's action families and all 48 serverbound PLAY packet types; item identifiers and packet schemas are generated from the installed versioned registry. Item combinations, coordinates, text, durations, recipes and NBT make the set of individual parameter combinations much larger than the list of action families.

## Contents

- [What agents can actually output today](#what-agents-can-actually-output-today)
- [How to describe an action](#how-to-describe-an-action)
- [Movement, camera and timing](#movement-camera-and-timing)
- [Hands, mining, placement and combat](#hands-mining-placement-and-combat)
- [Inventory: every click mode](#inventory-every-click-mode)
- [Crafting and every workstation family](#crafting-and-every-workstation-family)
- [Block and environmental interactions](#block-and-environmental-interactions)
- [Item use families](#item-use-families)
- [Entities, animals and vehicles](#entities-animals-and-vehicles)
- [Communication, menus and lifecycle](#communication-menus-and-lifecycle)
- [Local client controls](#local-client-controls)
- [Creative, spectator and privileged actions](#creative-spectator-and-privileged-actions)
- [Extensions and things that are not player actions](#extensions-and-things-that-are-not-player-actions)
- [Implementing this across interchangeable backends](#implementing-this-across-interchangeable-backends)
- [Complete item registry](#complete-item-registry)
- [Complete outgoing protocol checklist](#complete-outgoing-protocol-checklist)
- [Sources and maintenance](#sources-and-maintenance)

## What agents can actually output today

Source of truth: [core Action interface](../../packages/core/src/index.ts) and [Mineflayer environment](../../packages/agents/src/backends/mineflayer.ts).

| Implemented output | Value            | Current meaning                                                                                                     |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `controls.forward` | boolean          | Hold/release forward.                                                                                               |
| `controls.back`    | boolean          | Hold/release backward.                                                                                              |
| `controls.left`    | boolean          | Hold/release strafe left.                                                                                           |
| `controls.right`   | boolean          | Hold/release strafe right.                                                                                          |
| `controls.jump`    | boolean          | Hold/release jump; contextual swimming/climbing ascent.                                                             |
| `controls.sprint`  | boolean          | Request sprint; game conditions can prevent it.                                                                     |
| `controls.sneak`   | boolean          | Hold/release sneak; contextual descent/dismount.                                                                    |
| `look`             | `{ yaw, pitch }` | Absolute Mineflayer angles in **radians**; not protocol degrees or screen pixels.                                   |
| `dig`              | boolean          | When true, find the block at the cursor within the adapter's four-block search and await a dig attempt if diggable. |

Each current Mineflayer `apply()` clears the previous movement controls before applying the supplied controls. Repeat a held button in subsequent actions to keep it held. Omitted controls become released. `{}` releases movement controls. `dig: false` does **not** explicitly call `stopDigging()`; an explicit interrupt is not exposed. Digging is a higher-level asynchronous operation, not a raw mouse-down event. The simulator only implements simplified forward/back displacement and does not reproduce the full movement physics.

Example of an implemented action:

```json
{
  "controls": { "forward": true, "sprint": true, "jump": false },
  "look": { "yaw": 0, "pitch": 0 },
  "dig": false
}
```

There are currently **no policy output fields** for attack, use, offhand, hotbar selection, inventory, placing, crafting, chat or workstation choices. Backend capability declarations currently describe only `controls`, `look` and `dig`. The tables below describe Minecraft possibilities, not additional accepted JSON keys.

## How to describe an action

Use a small set of primitives with parameters rather than a separate output neuron for every item and recipe. For a future contract, useful parameters are:

| Parameter         | What it must specify                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Button state      | Press, hold, release; distinguish an edge from a held state.                                                       |
| Timing            | Duration/ticks, interrupt policy and completion deadline. Waiting/no-op is a valid decision.                       |
| View              | Absolute or relative yaw/pitch; define units, wrapping and permitted pitch range.                                  |
| Target            | Visible block position and hit face/point, or currently observed entity ID; never a hidden global entity lookup.   |
| Hand              | Main hand or offhand, plus the selected hotbar slot. Main hand is not necessarily the physical right hand.         |
| Inventory context | Window ID, server state/revision, slot, button, click mode and cursor stack.                                       |
| Selection         | Recipe identifier, displayed trade/option index, effect, pattern, or menu button.                                  |
| Text              | Message, item name, sign lines, book pages/title; validate lengths and allowed characters.                         |
| Result            | Attempted, accepted, rejected, completed, interrupted, timed out; record the reason and actual effects separately. |

The normal-player observation restriction still applies: an action should use information the player's client can see. Knowing the vanilla item registry is not permission to read hidden inventories or server-only state. Predictions of success are not authoritative confirmations.

## Movement, camera and timing

| Action family     | Variants and parameters                                                                        | Conditions / meaning                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Forward/backward  | Hold either direction or release.                                                              | Relative to facing; opposing inputs can cancel.                                  |
| Strafe            | Left/right; combine with forward/back for diagonals.                                           | No independent teleport or arbitrary velocity.                                   |
| Walk/sprint       | Start, hold, stop; combine with direction and jumping.                                         | Hunger, collision, item use and other state affect sprinting.                    |
| Sneak             | Start/hold/stop; toggle is a client preference.                                                | Slower movement, edge protection, contextual alternate interaction and dismount. |
| Jump              | Press/hold/release; repeated jumps while held where allowed.                                   | Standing jump, moving jump, sprint jump, jumping onto blocks.                    |
| Swim              | Move, sprint-swim, ascend with jump, descend with sneak.                                       | Pose transitions depend on water and collision.                                  |
| Climb             | Move into ladder/vines/scaffolding; ascend/descend; hold position with sneak where applicable. | Scaffolding has context-dependent sneak descent.                                 |
| Crawl             | Move in a low collision space after a valid pose transition.                                   | Java 1.18.1 has no ordinary standalone crawl button.                             |
| Look horizontally | Absolute yaw or relative turn.                                                                 | Facing changes movement and targeting.                                           |
| Look vertically   | Absolute pitch or relative tilt.                                                               | Define angle convention; normal player view is bounded.                          |
| Aim at a point    | Derived camera yaw/pitch from a visible point.                                                 | Convenience macro over looking.                                                  |
| Elytra deployment | Request fall-flying when airborne with usable elytra.                                          | Not arbitrary free flight.                                                       |
| Elytra steering   | Look/steer, stop gliding by landing or other valid transition.                                 | Firework propulsion is an item-use action.                                       |
| Vehicle movement  | Forward/back, left/right, steering/jump where vehicle supports them.                           | Detailed vehicle actions below.                                                  |
| Stop/no-op/wait   | Release selected/all buttons; wait a duration; keep a deliberate held state.                   | Releasing use/mining is separate from releasing movement.                        |
| Compound motion   | Any valid simultaneous combination: strafe-jump, sprint-jump, sneak-place, swim-turn, etc.     | Compound behaviors reuse primitives rather than adding hidden abilities.         |

Falling, knockback, sliding, crawling pose changes, buoyancy, bubble columns, swimming speed, stepping up, portal travel and collision are outcomes of physics and context. A player can initiate their causes but cannot directly set their result in survival.

## Hands, mining, placement and combat

| Action family        | Variants and parameters                                                  | Conditions / meaning                                                           |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Select hotbar slot   | Slots 0–8; next/previous via wheel; direct selection via number key.     | Changes held main-hand item.                                                   |
| Swap hands           | Exchange selected main-hand stack and offhand stack.                     | World shortcut or inventory swap; server validates context.                    |
| Swing arm            | Main/offhand animation.                                                  | A swing alone does not damage an entity or break a block.                      |
| Start mining         | Target block, hit face; hold attack.                                     | Tool, reach, hardness, mode and restrictions matter.                           |
| Continue mining      | Maintain target/button until break completes.                            | Time-based action; instant breaking is mode-dependent.                         |
| Abort mining         | Release, change target or explicit abort.                                | Different from declaring successful destruction.                               |
| Finish mining        | Client's completion attempt after permitted progress.                    | Server decides whether the block breaks.                                       |
| Attack entity        | Visible entity target; repeated attacks with timing.                     | Reach, line of sight, attack cooldown and server rules matter.                 |
| Melee techniques     | Critical hit, sprint knockback, sweeping, shield disabling.              | Outcomes of weapon, motion and timing; not separate guaranteed-result buttons. |
| Use item             | Begin/hold/release; main or offhand.                                     | The item's behavior chooses whether use is immediate, continuous or charged.   |
| Use block            | Block, face, local hit point, hand, sneak state.                         | Open/toggle/activate/place are selected by context.                            |
| Use entity           | Generic interact or interact-at with entity-local hit point and hand.    | Trading, mounting, feeding and equipping reuse this.                           |
| Place block          | Held block, neighboring face and hit point; aim/sneak/orientation.       | Includes directional blocks, slabs/stairs and replaceable blocks.              |
| Place entity/item    | Boat, minecart, armor stand, painting, frame, spawn egg where permitted. | Placement surface and permissions differ.                                      |
| Shield               | Raise/hold/lower using equipped shield.                                  | Main/offhand priority and cooldown matter.                                     |
| Bow                  | Start draw, hold, release; cancel by valid interruption.                 | Aim, draw duration and ammunition affect result.                               |
| Crossbow             | Charge, complete loading, fire loaded crossbow.                          | Loading and firing are distinct phases; arrows/fireworks are ammunition.       |
| Trident              | Charge/release throw or trigger Riptide in valid wet conditions.         | Melee use is still attack.                                                     |
| Throw/use projectile | Egg, snowball, ender pearl, splash/lingering potion, experience bottle.  | Hand, aim and cooldown; pearl teleport is an outcome.                          |
| Drop selected item   | One item or entire stack.                                                | Q/Ctrl+Q equivalents; not an inventory grant.                                  |

Eating while moving, shield use while moving, simultaneous hand use, mining during other interactions and tool switching must follow actual client/server arbitration. Do not assume all individually valid actions can run concurrently.

## Inventory: every click mode

These operate on the currently valid window. A slot is a **window-specific index**, not a universal item location. Cursor contents and server revisions are part of the state. The outside-window sentinel is `-999` for clicks; do not confuse it with the creative packet's special drop slot.

| Protocol mode  | Player operation                     | Variants                                                                                                                                                                                             |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0: pickup      | Normal left/right click.             | Pick up a stack; swap cursor and slot; merge into compatible stack; left-place as much as fits; right-pick roughly half; right-place one; click outside to drop all/one from cursor.                 |
| 1: quick move  | Shift-click.                         | Transfer between container/player inventory, or inventory/hotbar/equipment where that menu defines it; shift-take crafting/workstation output repeatedly where allowed.                              |
| 2: swap        | Hotbar/offhand shortcut over a slot. | Number-key swap with hotbar 0–8; offhand swap uses button 40 where supported.                                                                                                                        |
| 3: clone       | Creative middle-click.               | Copy a stack to the cursor; restricted to creative.                                                                                                                                                  |
| 4: throw       | Drop from a hovered slot.            | Button 0: one item; button 1: entire stack.                                                                                                                                                          |
| 5: quick craft | Drag-distribute cursor items.        | Start, add slots, finish; left-drag distributes evenly, right-drag places one per slot, creative middle-drag fills stacks. Left buttons 0/1/2, right 4/5/6, middle 8/9/10 are the respective phases. |
| 6: pickup all  | Double-click collect.                | Gather compatible items from eligible slots into cursor up to stack capacity; menu rules can exclude slots.                                                                                          |

All higher-level inventory operations are compositions of these validated clicks:

| Operation                 | Coverage                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open personal inventory   | Main storage, hotbar, armor, offhand and 2×2 crafting. Opening this screen itself is client-local.                                                                                           |
| Open/close container      | Chests, trapped chests, barrels, shulker boxes, ender chest, hopper, dispenser, dropper, vehicle inventories, workstations.                                                                  |
| Transfer/deposit/withdraw | Specific count, full stack, multiple stacks, all matching items, across valid source/destination ranges.                                                                                     |
| Split/merge/swap          | Cursor and slots, compatible stack limits, container-specific restrictions.                                                                                                                  |
| Equip/unequip             | Helmet, chestplate/elytra, leggings, boots, offhand; drag/quick move or contextual item use.                                                                                                 |
| Organize/sort             | Sequence of slot moves; vanilla 1.18.1 has no generic automatic sort button.                                                                                                                 |
| Collect output            | Crafting, furnace, trades and other result slots; consequences apply when taking output.                                                                                                     |
| Recover cursor contents   | Put back, merge, move to another slot, drop or close; closing behavior depends on menu.                                                                                                      |
| Bundle interactions       | The 1.18.1 registry includes experimental `bundle`; insert/remove via inventory clicks and spill via use if one is made available. Not a normal obtainable survival recipe in this baseline. |
| Pick block/item           | Middle-click target: survival searches for an existing matching hotbar/inventory stack; creative can create a copy.                                                                          |

Personal inventory window **0** uses: result 0; crafting grid 1–4; armor 5–8 (head to feet); main storage 9–35; hotbar 36–44; offhand 45. Container windows use different layouts. Dashboard starting-inventory slot numbers are a separate setup convention and must not be sent directly as window indices.

## Crafting and every workstation family

Every input below means items the player really possesses in visible slots. Recipes, outputs, costs and available options must come from the version/server/menu, not a hard-coded promise of success. Furnace and brewing operation happen over time after inputs are placed.

| Station / menu              | All player-controlled operations                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal 2×2 crafting       | Arrange/remove ingredients, shaped/shapeless recipes that fit, take one output or quick-move repeated output, clear grid.                                                                                                                          |
| Crafting table 3×3          | Open; fill/rearrange/clear nine input slots; choose recipe-book recipe; take output once/repeatedly.                                                                                                                                               |
| Recipe book                 | Open/close; select category; search locally; filter craftable; select/cycle recipe variants; request one recipe or make-all; acknowledge displayed/new recipes. Recipe-book requests arrange ingredients, not necessarily collect finished output. |
| Furnace                     | Add/remove input and fuel; collect output, including partial stacks.                                                                                                                                                                               |
| Blast furnace / smoker      | Same slot actions as furnace, restricted accepted recipe families and different processing speed.                                                                                                                                                  |
| Campfire / soul campfire    | Put cookable items on available cooking positions; wait and collect dropped results; light/extinguish. No normal furnace-style menu.                                                                                                               |
| Brewing stand               | Insert/remove up to three bottles, ingredient and blaze-powder fuel; collect potions; allow brewing to progress.                                                                                                                                   |
| Enchanting table            | Insert item/lapis; choose one of the three currently displayed enchantment offers; remove/take enchanted item. Server checks XP and lapis.                                                                                                         |
| Anvil                       | Insert base and material/book/second item; edit name including clearing it; repair/combine/enchant; take result and pay displayed cost.                                                                                                            |
| Grindstone                  | Insert one/two compatible items; repair and/or remove non-curse enchantments; take result and any resulting XP.                                                                                                                                    |
| Smithing table              | **1.18.1 two-input system:** diamond item + netherite ingot; take upgraded result. No smithing-template or armor-trim action in this version.                                                                                                      |
| Stonecutter                 | Insert accepted block; select one of the displayed recipes; take output once or repeatedly.                                                                                                                                                        |
| Loom                        | Insert banner/dye/optional banner-pattern item; choose a displayed pattern; take resulting banner.                                                                                                                                                 |
| Cartography table           | Insert map and paper/empty map/glass pane; take enlarged/copied/locked map where valid.                                                                                                                                                            |
| Villager / wandering trader | Open trade menu; select displayed offer; supply required items; take output; repeat until items/offer availability exhausted.                                                                                                                      |
| Beacon                      | Insert payment; choose available primary and optional secondary power; confirm activation; remove unspent input. Pyramid level determines available choices.                                                                                       |
| Lectern                     | Place/remove book via interaction; open; previous/next/jump-to-page; take book when permitted. Book pagination can affect redstone output.                                                                                                         |
| Horse-family inventory      | Open mount's equipment/storage; saddle, horse armor, carried chest slots where species/state supports them.                                                                                                                                        |
| Generic menu buttons        | Select a valid currently displayed button/option using menu-specific semantics. The protocol's `enchant_item` packet is also used by non-enchanting menus.                                                                                         |

Crafting a sword, ladder, bed, banner, firework or any other recipe is the same family with different recipe/ingredients. Dyeing leather armor, repairing compatible tools in the crafting grid, copying written books, map crafting and banner/shield combinations also belong to recipe operations when available. There is no serverbound packet per crafted item.

## Block and environmental interactions

| Target / action family         | Player-controlled choices                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doors, trapdoors, fence gates  | Open/close if directly operable; iron variants need redstone.                                                                                                                                                                           |
| Buttons and levers             | Press button; toggle lever; release is automatic for buttons.                                                                                                                                                                           |
| Pressure plates / tripwire     | Move onto/through/off; dropped items/projectiles can activate compatible devices.                                                                                                                                                       |
| Containers / workstations      | Open, manipulate menu, close; sneak-use can place against them instead of opening.                                                                                                                                                      |
| Redstone components            | Change repeater delay; toggle comparator mode; tune/play note block; set daylight detector mode; connect/place/remove dust and components.                                                                                              |
| Bed                            | Attempt sleep, leave bed; set spawn through valid bed interaction; invalid-dimension explosion is an outcome.                                                                                                                           |
| Respawn anchor                 | Add glowstone charge; interact to set spawn when valid; invalid-dimension explosion is an outcome.                                                                                                                                      |
| Bell                           | Ring with interaction/attack or applicable projectile.                                                                                                                                                                                  |
| Cake / candle cake             | Eat a slice; add candle to whole cake where allowed; light/extinguish candle.                                                                                                                                                           |
| Candles / campfires / TNT      | Ignite with appropriate item; extinguish candles or campfire with valid interaction/fluid/tool; break/move by ordinary mechanics.                                                                                                       |
| Flower pot                     | Insert accepted plant; remove it with valid empty-hand interaction.                                                                                                                                                                     |
| Composter                      | Add accepted compostable items; collect ready bone meal.                                                                                                                                                                                |
| Beehive / bee nest             | Collect honey bottle with bottle or honeycomb with shears when ready; smoke affects bee response.                                                                                                                                       |
| Sweet berry bush / cave vines  | Harvest ripe berries; ordinary breaking is separate.                                                                                                                                                                                    |
| Crops / saplings / vegetation  | Plant suitable seeds/plants, bone-meal valid target, harvest by breaking, shear valid plant, till/path/strip with tool.                                                                                                                 |
| Farmland                       | Hoe to till; move/jump/fall to cause trampling under valid conditions.                                                                                                                                                                  |
| Snow / layers / powder snow    | Place snow layers; collect/place powder snow with bucket; boots change collision and movement.                                                                                                                                          |
| Cauldron                       | Fill/empty water/lava/powder snow with appropriate bucket; water-bottle interactions; wash dye from leather armor, banner patterns or dyed shulker boxes where valid. Java baseline does not brew/store potions like Bedrock cauldrons. |
| Fluids                         | Scoop a source into bucket; place bucket contents; waterlog compatible blocks; release bucketed aquatic mob.                                                                                                                            |
| Sponge                         | Place to absorb water; dry through appropriate environment/furnace; absorption is a result.                                                                                                                                             |
| Signs                          | Enter/edit text when the sign editor is legitimately opened; single face, four lines in 1.18.1; dye/glow ink/ink interaction. Existing signs cannot generally be freely reopened for text editing in this baseline.                     |
| Item/glow item frames          | Insert held item, rotate displayed item, remove item/break frame with attacks.                                                                                                                                                          |
| Painting / armor stand         | Place, interact where supported, attack to remove; armor-stand details below.                                                                                                                                                           |
| Jukebox                        | Insert record or eject current record. Playback sound is an outcome.                                                                                                                                                                    |
| Bookshelf / decorative blocks  | Place/break normally. Chiseled-bookshelf storage is a later-version feature.                                                                                                                                                            |
| Dragon egg                     | Interact/attack to trigger relocation; collect using valid physical setup. No ordinary direct pickup control.                                                                                                                           |
| End portal / Nether portal     | Insert eyes into valid end frames; ignite valid Nether portal; move into active portal.                                                                                                                                                 |
| End crystals / boss structures | Place permitted crystals; build valid wither/golem structures; bosses/spawning are resulting mechanics.                                                                                                                                 |
| Trap setup / circuits          | Build, fill dispensers, set mechanisms and trigger through normal interactions. Not a direct server instruction to damage another player.                                                                                               |

## Item use families

Each item may support several contexts: attack, use in air, use on a block, use on an entity, placement, inventory manipulation or recipe ingredient. An item ID alone is insufficient to select its behavior.

| Family                                       | Actions / examples                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Food and drinks                              | Begin/hold/finish/cancel consumption; normal food, milk bucket, potion, honey bottle, stew. Server decides whether consumption is allowed.                                |
| Throwable items                              | Throw eggs, snowballs, pearls, splash/lingering potions, experience bottles.                                                                                              |
| Weapons                                      | Melee attack; bow/crossbow charge/fire; trident throw/Riptide; shield raise/lower.                                                                                        |
| Fishing rod                                  | Cast, reel in, release/interrupt as appropriate; hook entities/items when mechanics permit.                                                                               |
| Firework rocket                              | Launch against block or use to boost elytra; crossbow ammunition is a different context.                                                                                  |
| Buckets                                      | Fill/empty water/lava/powder snow; milk supported mobs; capture/release supported aquatic mobs with suitable bucket.                                                      |
| Glass bottle                                 | Fill water, gather dragon breath, collect honey when valid.                                                                                                               |
| Flint and steel / fire charge                | Ignite valid block/portal/TNT/campfire/candle; fire charges are not freely thrown like snowballs.                                                                         |
| Hoe / shovel / axe                           | Till farmland; create dirt path; strip wood; remove copper oxidation or wax where tool rules permit.                                                                      |
| Shears                                       | Shear sheep/mooshroom/plants; harvest honeycomb; cut supported targets.                                                                                                   |
| Bone meal                                    | Fertilize/grow applicable land/water vegetation or crops. Growth is server randomness.                                                                                    |
| Dye / ink / glow ink                         | Dye supported entity/block/sign; restore ordinary sign text or make it glow; item crafting dye operations use recipes.                                                    |
| Honeycomb                                    | Wax copper; crafting ingredient. Sign waxing is a later-version feature.                                                                                                  |
| Fertilizer/planting/placeable items          | Seeds, saplings, crops, flowers, sugar cane, kelp, bamboo, cocoa, berries, mushrooms, candles, rails, redstone, beds, etc. Context and support determine valid placement. |
| Eye of ender                                 | Throw to locate stronghold; insert into end portal frame.                                                                                                                 |
| End crystal                                  | Place on permitted base with required clearance.                                                                                                                          |
| Compass / map                                | Bind compass to lodestone; initialize empty map; hold/read map. Ordinary compass/clock reading is an observation, not a separate activate command.                        |
| Writable book                                | Edit pages, insert/delete text, sign with title and finalize. Signed books are read-only; copies use recipes.                                                             |
| Written book                                 | Open/read, navigate pages and permitted text links. Local reading is distinct from lectern page changes.                                                                  |
| Name tag                                     | Rename through anvil, then apply to supported entity. No survival name-tag crafting recipe in 1.18.1.                                                                     |
| Saddle / horse armor / chest                 | Equip compatible animal by valid interaction or inventory; attach storage to donkey/mule/llama where supported.                                                           |
| Lead                                         | Attach/detach compatible entity; tether to fence; lead breaks are contextual outcomes.                                                                                    |
| Carrot on a stick / warped fungus on a stick | Steer compatible mount; use to request boost.                                                                                                                             |
| Totem of undying                             | Equip in a hand. Activation on otherwise lethal damage is automatic, not a button.                                                                                        |
| Spawn egg                                    | Spawn compatible entity against block or interact with spawner where game mode/permissions allow. Not ordinarily obtainable survival equipment.                           |
| Debug stick                                  | Select/cycle block-state properties only with required creative/operator permission.                                                                                      |
| Bundle                                       | Experimental baseline item, inventory insertion/removal and emptying if supplied. Do not apply newer bundle-selection UI to 1.18.1.                                       |
| Ordinary non-usable items                    | Move/drop/equip if valid, attack while holding, or use as ingredients. A material such as an ingot need not have a special right-click action.                            |

The [complete registry below](#complete-item-registry) includes every one of the baseline's **1,100 item IDs**, including variants, spawn eggs and restricted/experimental items. Their presence in the registry does not mean every item is obtainable or usable in survival.

## Entities, animals and vehicles

| Target / family               | Player operations                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General entity                | Attack, main/offhand interact, interact at local hit point, attempt mount where supported.                                                                            |
| Animals                       | Feed/heal compatible species, breed, attempt taming through appropriate food/riding; lead/tether; name. Success/state transitions are server decisions.               |
| Wolf / cat / parrot           | Owner sit/stand toggle when valid; heal/feed/tame using species-appropriate items; wolf collar dye; parrot shoulder interaction follows normal mechanics.             |
| Sheep / mooshroom             | Sheep dye/shear; mooshroom shear or milk/stew interaction with valid held item.                                                                                       |
| Cow / goat                    | Milk with empty bucket where supported.                                                                                                                               |
| Horse / donkey / mule / llama | Mount/tame through riding; open equipment/storage; feed; saddle/armor/chest/carpet depending on species. Not every species supports every equipment type.             |
| Pig / strider                 | Saddle, mount, steer with matching stick item, request boost; dismount.                                                                                               |
| Horse jump                    | Begin charging, release with charge strength while riding eligible mount.                                                                                             |
| Boat                          | Place, board, forward/back/turn/paddle, dismount, break; boat movement differs from generic mount steering.                                                           |
| Minecart                      | Place on rail, board/dismount, push through movement, break; open chest/hopper cart; fuel furnace cart where supported. Rail/redstone determines motion.              |
| Armor stand                   | Equip/remove/exchange held item, armor and offhand using hand and hit location; attack/break. Ordinary Java survival does not expose unrestricted stand pose editing. |
| Villager / trader             | Interact to trade; select/pay/take offers. Trading is not a direct arbitrary inventory transfer.                                                                      |
| Allay / later mobs            | Not part of vanilla 1.18.1; register after upgrading, not as a baseline action.                                                                                       |
| Item / experience orb         | Move into pickup range; pickup is automatic if eligible. No normal universal remote-collect packet.                                                                   |
| Spectator entity camera       | Attach to/leave an entity camera with permitted spectator controls; separate from survival interaction.                                                               |

Additional contextual entity interactions include starting zombie-villager curing with weakness and a golden apple, repairing iron golems with iron ingots, shearing snow-golem pumpkins, and offering appropriate items to piglins or item-taking mobs. These use ordinary item/entity/drop primitives; delayed conversion, bartering, pickup and trust are server outcomes.

## Communication, menus and lifecycle

| Family                        | Variants / boundaries                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat                          | Open chat; type/edit; submit; history; close. Only submitted message is normally sent to server.                                                                                   |
| Whisper                       | Server-supported `/msg`/equivalent command, target and text; not a universal special whisper packet.                                                                               |
| Non-privileged commands       | Submit commands allowed by that server, e.g. help or messaging. Names and permissions are server-defined.                                                                          |
| Completion                    | Request tab completions for partial command/text; cycle/select results locally.                                                                                                    |
| Clickable chat/book text      | Open URL/file prompt, copy text, suggest/run command, change page where the client supports it. Execution requires appropriate confirmation/allowlist.                             |
| Advancement UI                | Open, choose advancement tab, close; tab state can be sent to server.                                                                                                              |
| Statistics                    | Open/request updated statistics; read/navigate locally.                                                                                                                            |
| Recipe UI                     | Recipe-book state/selection/acknowledgment as detailed above.                                                                                                                      |
| Death screen                  | Request respawn when server permits; leave to title/disconnect. Hardcore restrictions differ.                                                                                      |
| Sleep screen                  | Leave bed; chat while sleeping as allowed.                                                                                                                                         |
| Resource pack prompt          | Accept/decline; report download/loaded/failed status. Download outcomes are adapter events, not policy wishes.                                                                     |
| Join / disconnect / reconnect | Authentication, connect, graceful disconnect, reconnect. These are session management operations, normally runner-owned.                                                           |
| Client settings               | Locale, view distance, chat mode/colors, skin-part visibility, dominant hand, text-filtering flag, server-listing preference. Serverbound settings do not grant extra information. |
| Plugin menus / server GUI     | Click valid displayed slots/buttons; submit plugin-supported text or command. Specific actions require that plugin's documented contract.                                          |

## Local client controls

These are real player outputs, but many never emit a dedicated packet and are unavailable in a headless protocol bot. A full rendered-client backend must expose them explicitly if training needs them. They are **not** currently agent actions.

| Family                  | Controls                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen navigation       | Open/close inventory, chat, pause/options, advancements, statistics; move GUI cursor; click/drag/scroll; navigate/focus controls; type/edit/search; confirm/cancel.                                     |
| View and presentation   | First-person/third-person back/third-person front, hide/show HUD, toggle debug overlay, show player list while held, show subtitles, change FOV, brightness, GUI scale and fullscreen/window size.      |
| Item information        | Hover tooltip, advanced tooltip toggle, recipe-book category/search/filter, creative search/tab selection.                                                                                              |
| Audio                   | Master/category volumes, mute/unmute through settings; device options supported by client/OS. Vanilla Java has no built-in microphone or voice-chat output.                                             |
| Rendering/performance   | Render/simulation distance settings, graphics, particles, clouds, entity distance, frame cap, VSync, biome blend, resource packs. Server imposes its own limits.                                        |
| Input preferences       | Keybinds, sensitivity, invert mouse, raw mouse input, auto-jump, toggle/hold sneak/sprint, accessibility settings.                                                                                      |
| Capture                 | Screenshot; local debug/performance recording where supported. Screenshot is a local artifact, not an in-world attack/use action.                                                                       |
| Debug shortcuts         | Reload chunks/resources, show hitboxes/chunk borders, copy coordinates, pause on lost focus, show diagnostic graphs and other version-supported F3 combinations. Debug NBT queries require permissions. |
| Creative hotbar presets | Save/load toolbar layouts using number-key combinations; loading items is creative-restricted.                                                                                                          |
| Menu/session settings   | Language, controls, skin customization, sounds, video, accessibility, server entry selection, resource-pack selection; title-screen actions exist outside PLAY.                                         |

Accessibility also includes toggling/cycling narrator mode and text-background/chat presentation settings. These change local presentation rather than world state.

Client debug information and alternate viewpoints can change observations. Enable them deliberately in experiment configuration; do not silently give policies extra information beyond the chosen player-visible regime.

## Creative, spectator and privileged actions

Keep these outside an ordinary survival policy's action allowlist. ChilledVibe's viewer permissions do not imply that training agents have operator privileges.

| Restricted family    | Possible output                                                                                                                                                                   | Restriction                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Creative inventory   | Search/tab, select any allowed item, create/delete/replace stacks, clone, creative drag-fill, creative pick block with NBT where supported.                                       | Server creative mode and permitted item data.                                                                          |
| Creative movement    | Toggle flying, ascend/descend, steer/sprint-fly, stop flying.                                                                                                                     | Server-granted flight capability.                                                                                      |
| Creative mining      | Instant break except client exceptions; attack/place ordinary targets.                                                                                                            | Creative rules, not survival mining speed.                                                                             |
| Spectator movement   | No-clip flight, ascend/descend, adjust movement speed.                                                                                                                            | Server spectator mode.                                                                                                 |
| Spectator selection  | Open player teleport selector; request spectate/teleport to selected entity/player; enter/exit entity camera.                                                                     | Spectator permissions and server constraints.                                                                          |
| Spectator inspection | View permitted container screens without modifying them.                                                                                                                          | No normal inventory editing, attacking or placing.                                                                     |
| Debug NBT query      | Request block/entity NBT using permitted debug action.                                                                                                                            | Operator permission; not normal player-visible telemetry.                                                              |
| Command block        | Edit block/minecart command and permitted execution options.                                                                                                                      | Creative/operator requirements.                                                                                        |
| Structure block      | Configure name, mode, position/size, flags, integrity, seed and related save/load actions.                                                                                        | Operator permission.                                                                                                   |
| Jigsaw block         | Edit name/target/pool/joint/final state; request generation with levels/options.                                                                                                  | Operator permission.                                                                                                   |
| Difficulty controls  | Change/lock difficulty in contexts that permit it.                                                                                                                                | Usually integrated-server/admin control, not remote survival player choice.                                            |
| Operator commands    | Teleport, give, summon, gamemode, world rules, weather/time, fill/setblock, clear, kill, effect, enchant, attribute, XP, scoreboard, teams, datapacks and server/plugin commands. | Server-specific command grammar and permissions. An unbounded command string must not become an ordinary agent action. |

## Extensions and things that are not player actions

Later versions add items, mobs, menus and mechanics. Examples include brush/archaeology, armor trims and template-based smithing, hanging/two-sided editable/waxed signs, chest boats, chiseled bookshelves, crafter interactions and newer combat items. These require a version-specific extension rather than pretending they exist in 1.18.1. Mods/plugins can add arbitrary machines, spells, abilities, keybinds, voice chat, quests, backpacks and custom payloads. A Bedrock controller has different protocol and some different mechanics.

| Not a direct survival output                                                         | Correct owner / interpretation                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Set health, hunger, saturation, XP, attributes, effects or cooldown                  | Server simulation; privileged setup if explicitly authorized. A player may cause changes through ordinary actions. |
| Set position/velocity/pose/invulnerability or force successful hit                   | Physics/server authority; movement and interactions are attempts.                                                  |
| Set world seed/type, reset terrain, reconstruct cage/arena, summon batch agents      | Dashboard/runtime experiment preparation.                                                                          |
| Give starting inventory, keepInventory, difficulty, mob griefing, no-hunger rules    | Experiment setup/server rules, not policy actions.                                                                 |
| Advance/end generation, pause training, change sampling speed, alter training length | Training controller; not Minecraft player abilities.                                                               |
| Agent checkpoint/model update, rewards, fitness, logs, graph points                  | Training outputs, distinct from environment actions.                                                               |
| Pick up nearby item/XP, take damage, respawn at chosen bed after accepted request    | Server outcomes/events. Movement or respawn request is the player action.                                          |
| Heartbeat, pong, teleport acknowledgment, synchronization                            | Backend protocol obligations; do not ask a policy to choose whether to maintain its connection.                    |

## Implementing this across interchangeable backends

Use the existing [backend interface](../agent-backends.md). Extend the **shared Action type**, capability metadata, validation, selected-environment dispatch, adapters and run recording together; adding a row to this README does not implement it.

1. Define backend-independent action families with typed parameters and version/mode requirements. Keep packet names and Mineflayer objects inside adapters.
2. Distinguish low-level button actions from multi-step macros such as `craft` or `transfer`. Decide whether macros are interruptible and whether they advance simulation/training time.
3. Advertise implemented capabilities per adapter. Unsupported requests must fail clearly rather than silently succeeding. The current capability enum needs extension for additional families.
4. Derive an **action mask** from observed context: loaded visible targets, reach, current menu revision, available slots/items/recipes, game mode and granted permissions. Treat the mask as advisory because state can race.
5. Bound duration, text, count and concurrency; serialize conflicting GUI operations; verify accepted server updates before reporting completion. A packet written to the socket is not evidence of success.
6. Keep privileged setup and client/session maintenance separate from policy actions. Log requested action, version/backend, timestamps, acceptance, completion and interruption for replay/debugging.

Installed Mineflayer already has helpers for many missing families: `attack`, `activateItem`/`deactivateItem`, `activateBlock`/`activateEntity`/`activateEntityAt`, `setQuickBarSlot`, `equip`/`unequip`, `toss`, `placeBlock`/`placeEntity`, `stopDigging`, `clickWindow`, `transfer`, `craft`, workstation helpers, `sleep`/`wake`, `mount`/`dismount`, `moveVehicle`, `elytraFly`, `writeBook`, `updateSign`, `chat`, and `respawn`. Helpers are version/context dependent and may not implement every GUI edge case. Local typings/source, not method names alone, determine the installed adapter behavior.

## Complete item registry

See [items.json](items.json): all **1,100 items**, sorted by namespaced identifier, with registry numeric ID, display name, stack size and available durability metadata. This includes every individual colored/material variant rather than just broad families. Numeric IDs are version-specific; use `minecraft:...` names in portable configuration. Some items require creative/operator access or are experimental. Block states, item NBT variants, enchantments and recipe combinations are not separate item IDs.

The current registry is a baseline snapshot, not the live server's datapack recipe/trade list. Recipes can be changed by datapacks and plugins; a full action implementation must use the actual advertised recipe/menu data. The same applies to mods adding their own namespaces.

## Complete outgoing protocol checklist

The following generated table contains **all 48 serverbound PLAY packets**, with their actual fields. It includes normal actions, UI preferences, maintenance, and privileged operations so none are silently mistaken for survival abilities. Full nested field schemas, shared protocol types and inventory/dig/entity-action mode meanings are in [protocol.json](protocol.json).

These are wire messages, **not** 48 independent policy actions: many human actions share a packet, while a macro may send several packets. Handshake, login/authentication and status-query states are session transport, not PLAY; they are documented as such rather than offered as gameplay outputs.

<!-- protocol-table:start -->

| ID     | Packet                          | Meaning / owner                                                                             | Fields (conditional fields included)                                                                                                                                   |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x00` | `teleport_confirm`              | Maintenance: acknowledge server teleport; not a teleport ability.                           | `teleportId`                                                                                                                                                           |
| `0x01` | `query_block_nbt`               | Restricted: debug block-NBT query.                                                          | `transactionId`, `location`                                                                                                                                            |
| `0x02` | `set_difficulty`                | Restricted: request difficulty change where permitted.                                      | `newDifficulty`                                                                                                                                                        |
| `0x03` | `chat`                          | Submit chat or slash command; command permissions apply.                                    | `message`                                                                                                                                                              |
| `0x04` | `client_command`                | Request respawn or updated statistics.                                                      | `actionId`                                                                                                                                                             |
| `0x05` | `settings`                      | Send client preferences, not world rules.                                                   | `locale`, `viewDistance`, `chatFlags`, `chatColors`, `skinParts`, `mainHand`, `enableTextFiltering`, `enableServerListing`                                             |
| `0x06` | `tab_complete`                  | Request text/command completions.                                                           | `transactionId`, `text`                                                                                                                                                |
| `0x07` | `enchant_item`                  | Select current menu button; also used outside enchanting.                                   | `windowId`, `enchantment`                                                                                                                                              |
| `0x08` | `window_click`                  | Inventory/menu click, revision and predicted changes.                                       | `windowId`, `stateId`, `slot`, `mouseButton`, `mode`, `changedSlots`, `cursorItem`                                                                                     |
| `0x09` | `close_window`                  | Close current inventory/container menu.                                                     | `windowId`                                                                                                                                                             |
| `0x0a` | `custom_payload`                | Client-brand/plugin/mod payload; channel-defined behavior.                                  | `channel`, `data`                                                                                                                                                      |
| `0x0b` | `edit_book`                     | Edit book; optional title signs it. Legacy hand field means inventory slot in this version. | `hand`, `pages`, `title`                                                                                                                                               |
| `0x0c` | `query_entity_nbt`              | Restricted: debug entity-NBT query.                                                         | `transactionId`, `entityId`                                                                                                                                            |
| `0x0d` | `use_entity`                    | Interact, attack, or interact at entity-local point.                                        | `target`, `mouse`, `x`, `y`, `z`, `hand`, `sneaking`                                                                                                                   |
| `0x0e` | `generate_structure`            | Restricted: request jigsaw structure generation.                                            | `location`, `levels`, `keepJigsaws`                                                                                                                                    |
| `0x0f` | `keep_alive`                    | Maintenance: heartbeat reply.                                                               | `keepAliveId`                                                                                                                                                          |
| `0x10` | `lock_difficulty`               | Restricted: request difficulty lock where permitted.                                        | `locked`                                                                                                                                                               |
| `0x11` | `position`                      | Report control/physics-generated position; server validates.                                | `x`, `y`, `z`, `onGround`                                                                                                                                              |
| `0x12` | `position_look`                 | Report position and camera together; server validates.                                      | `x`, `y`, `z`, `yaw`, `pitch`, `onGround`                                                                                                                              |
| `0x13` | `look`                          | Report camera orientation in protocol degrees.                                              | `yaw`, `pitch`, `onGround`                                                                                                                                             |
| `0x14` | `flying`                        | Report on-ground state; packet name does not grant flight.                                  | `onGround`                                                                                                                                                             |
| `0x15` | `vehicle_move`                  | Report controlled vehicle position/orientation.                                             | `x`, `y`, `z`, `yaw`, `pitch`                                                                                                                                          |
| `0x16` | `steer_boat`                    | Report boat paddle input.                                                                   | `leftPaddle`, `rightPaddle`                                                                                                                                            |
| `0x17` | `pick_item`                     | Move existing inventory item to selected hotbar slot.                                       | `slot`                                                                                                                                                                 |
| `0x18` | `craft_recipe_request`          | Request recipe placement in current crafting menu.                                          | `windowId`, `recipe`, `makeAll`                                                                                                                                        |
| `0x19` | `abilities`                     | Toggle flying only if server has granted permission.                                        | `flags`                                                                                                                                                                |
| `0x1a` | `block_dig`                     | Mine start/cancel/finish, drop stack/item, release use, swap hands.                         | `status`, `location`, `face`                                                                                                                                           |
| `0x1b` | `entity_action`                 | Sneak/sprint, leave bed, horse jump/inventory, elytra start.                                | `entityId`, `actionId`, `jumpBoost`                                                                                                                                    |
| `0x1c` | `steer_vehicle`                 | Vehicle directional input and jump/dismount flags.                                          | `sideways`, `forward`, `jump`                                                                                                                                          |
| `0x1d` | `pong`                          | Maintenance: reply to server ping.                                                          | `id`                                                                                                                                                                   |
| `0x1e` | `recipe_book`                   | Set recipe-book open/filter preferences.                                                    | `bookId`, `bookOpen`, `filterActive`                                                                                                                                   |
| `0x1f` | `displayed_recipe`              | Acknowledge displayed recipe.                                                               | `recipeId`                                                                                                                                                             |
| `0x20` | `name_item`                     | Change anvil naming text.                                                                   | `name`                                                                                                                                                                 |
| `0x21` | `resource_pack_receive`         | Report resource-pack acceptance/download outcome.                                           | `result`                                                                                                                                                               |
| `0x22` | `advancement_tab`               | Select advancement tab or report screen close.                                              | `action`, `tabId`                                                                                                                                                      |
| `0x23` | `select_trade`                  | Select displayed trade offer.                                                               | `slot`                                                                                                                                                                 |
| `0x24` | `set_beacon_effect`             | Choose beacon powers; payment/level restrictions apply.                                     | `primary_effect`, `secondary_effect`                                                                                                                                   |
| `0x25` | `held_item_slot`                | Select hotbar slot 0–8.                                                                     | `slotId`                                                                                                                                                               |
| `0x26` | `update_command_block`          | Restricted: edit command block.                                                             | `location`, `command`, `mode`, `flags`                                                                                                                                 |
| `0x27` | `update_command_block_minecart` | Restricted: edit command-block minecart.                                                    | `entityId`, `command`, `track_output`                                                                                                                                  |
| `0x28` | `set_creative_slot`             | Creative: set/delete stack or drop via special slot.                                        | `slot`, `item`                                                                                                                                                         |
| `0x29` | `update_jigsaw_block`           | Restricted: edit jigsaw configuration.                                                      | `location`, `name`, `target`, `pool`, `finalState`, `jointType`                                                                                                        |
| `0x2a` | `update_structure_block`        | Restricted: configure/save/load structure block.                                            | `location`, `action`, `mode`, `name`, `offset_x`, `offset_y`, `offset_z`, `size_x`, `size_y`, `size_z`, `mirror`, `rotation`, `metadata`, `integrity`, `seed`, `flags` |
| `0x2b` | `update_sign`                   | Submit four sign lines through valid editor context.                                        | `location`, `text1`, `text2`, `text3`, `text4`                                                                                                                         |
| `0x2c` | `arm_animation`                 | Swing hand; damage/mining is separate.                                                      | `hand`                                                                                                                                                                 |
| `0x2d` | `spectate`                      | Spectator: request camera/teleport target UUID.                                             | `target`                                                                                                                                                               |
| `0x2e` | `block_place`                   | Use item on block hit point; may place or interact.                                         | `hand`, `location`, `direction`, `cursorX`, `cursorY`, `cursorZ`, `insideBlock`                                                                                        |
| `0x2f` | `use_item`                      | Use held item in air with selected hand.                                                    | `hand`                                                                                                                                                                 |

<!-- protocol-table:end -->

## Sources and maintenance

- [Minecraft's official controls guide](https://www.minecraft.net/article/minecraft-controls) describes ordinary movement, inventory, attack/place and use controls. It discusses multiple editions; this catalog's baseline is Java.
- [PrismarineJS minecraft-data versioned registry](https://github.com/PrismarineJS/minecraft-data) supplies the installed 1.18.1 item identifiers and exact protocol schemas. Local resolved data, including its effective version, is recorded in both JSON files.
- [Mineflayer upstream API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md) and the installed `node_modules/mineflayer/index.d.ts` / `lib/plugins/` are references for potential adapter mappings, not evidence that MLCraft exposes them.
- [MLCraft shared contract](../../packages/core/src/index.ts), [actual adapter](../../packages/agents/src/backends/mineflayer.ts), and [backend guide](../agent-backends.md) define current support.

Regenerate the registry JSON and packet table after dependency/version changes:

```powershell
node scripts/export-player-outputs.mjs
# Optional alternate version: creates a separate reference folder;
# the human-authored 1.18.1 README still needs a version/mechanics review.
node scripts/export-player-outputs.mjs 1.21.1 docs/player-outputs-1.21.1
```

The exporter checks that it receives the requested Minecraft version and fails rather than silently using a fallback. Review the human-readable mechanics whenever the server version, mods, available menus or shared Action contract changes. The generated files prove protocol/item coverage, not that every contextual behavior has been implemented or integration-tested.
