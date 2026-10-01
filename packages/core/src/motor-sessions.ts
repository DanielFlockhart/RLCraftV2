export const motorSessions = [
  {
    id: "M0",
    name: "Straight-line flat movement",
    detail: "Reach a target along a clear flat lane.",
  },
  {
    id: "M1",
    name: "Random target directions",
    detail: "Reach targets in different directions on flat ground.",
  },
  {
    id: "M2",
    name: "Longer distances / sprinting",
    detail: "Cross a longer flat lane efficiently.",
  },
  {
    id: "M3",
    name: "Single-block obstacles",
    detail: "Jump over a one-block barrier.",
  },
  {
    id: "M4",
    name: "Procedural obstacle courses",
    detail: "Navigate a seeded obstacle layout.",
  },
  {
    id: "M5",
    name: "Uneven terrain",
    detail: "Cross step changes in ground height.",
  },
  {
    id: "M6",
    name: "Water / complex terrain",
    detail: "Cross water and mixed blocks.",
  },
  {
    id: "M7",
    name: "Natural Minecraft terrain",
    detail: "Navigate a constructed natural terrain patch.",
  },
  {
    id: "M8",
    name: "Generalisation to unseen terrain/seeds",
    detail: "Evaluate on a fresh seeded terrain layout.",
  },
] as const;
