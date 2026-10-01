# Phase 3A motor training

Training → Phase 3A provides nine individual sessions, M0–M8. Each session starts a Minecraft run with a NEAT population. The agent receives target offset, velocity, yaw, pitch, on-ground state, and three local depth samples when the backend supplies geometry. Its eight outputs control forward, back, left, right, jump, sprint, yaw delta, and pitch delta. Yaw and pitch deltas are converted to normal player look actions.

| Session | Arena task                                               |
| ------- | -------------------------------------------------------- |
| M0      | Straight flat lane                                       |
| M1      | New target direction each episode                        |
| M2      | Long flat lane for sprinting                             |
| M3      | One-block barrier                                        |
| M4      | Seeded obstacle course                                   |
| M5      | Uneven block heights                                     |
| M6      | Water and mixed blocks                                   |
| M7      | Constructed natural terrain patch                        |
| M8      | New seeded terrain layout using an evolved M7 checkpoint |

Clicking **Run** selects or creates the dedicated superflat world if no other Minecraft run is active. The control service saves the existing world and starts the motor world. Each agent occupies its own barrier-bounded arena cell, with a gap between cells. Player combat and mob spawning are disabled. Arena blocks and agent placement are rebuilt before each episode. The world selected before motor training remains stored and can be reactivated from Training worlds; the service does not delete it.

The NEAT population has at least eight genomes. Each agent evaluates one candidate per episode; a generation evolves after every candidate has received reward. Fitness is based on actual target progress, arrival, step cost, and death. NEAT mutates weights, connections, and nodes, groups compatible graphs into species, and crosses parents within species. The run writes episode reports and atomically updates `checkpoint.json` after every completed episode, including when more episodes remain. That file contains the population and champion, and is available as a run artifact even if the run is later stopped. M1–M8 load the latest completed previous-session checkpoint when available. M8 requires an evolved M7 checkpoint and a different terrain seed.

Protocol agents can run larger populations; Fabric agents offer an RGB camera but use renderer capacity and currently have no local depth channel. The NEAT policy consumes available geometry when provided. M7 and M8 use generated arena terrain in a superflat world, rather than a naturally generated overworld. Terrain and target layouts are deterministic for the session seed so runs can be compared.
