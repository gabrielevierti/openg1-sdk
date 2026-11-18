/**
 * A short built-in route in OSRM's own response shape: a few streets, a
 * roundabout, a stretch with speed limits. It lets the navigator be tried —
 * and tested — with no network and no GPS.
 */
export const DEMO_OSRM_ROUTE = {
  distance: 3061,
  duration: 360,
  geometry: {
    coordinates: [
      [9.18, 45.47], [9.184, 45.47], [9.188, 45.47], [9.192, 45.47],
      [9.192, 45.473], [9.192, 45.476], [9.192, 45.479],
      [9.196, 45.479], [9.2, 45.479], [9.2, 45.482], [9.2, 45.4835],
    ],
  },
  legs: [
    {
      annotation: {
        maxspeed: [
          { speed: 50, unit: "km/h" }, { speed: 50, unit: "km/h" }, { speed: 50, unit: "km/h" },
          { speed: 30, unit: "km/h" }, { speed: 30, unit: "km/h" }, { unknown: true },
          { speed: 50, unit: "km/h" }, { speed: 50, unit: "km/h" }, { speed: 30, unit: "km/h" }, { speed: 30, unit: "km/h" },
        ],
      },
      steps: [
        { name: "Via Dante", maneuver: { type: "depart", modifier: "right" }, geometry: { coordinates: [[9.18, 45.47], [9.184, 45.47], [9.188, 45.47], [9.192, 45.47]] } },
        { name: "Via Manzoni", maneuver: { type: "turn", modifier: "left" }, geometry: { coordinates: [[9.192, 45.47], [9.192, 45.473], [9.192, 45.476], [9.192, 45.479]] } },
        { name: "Piazza Cavour", maneuver: { type: "roundabout", modifier: "right", exit: 2 }, geometry: { coordinates: [[9.192, 45.479], [9.196, 45.479], [9.2, 45.479]] } },
        { name: "Via Turati", maneuver: { type: "turn", modifier: "left" }, geometry: { coordinates: [[9.2, 45.479], [9.2, 45.482], [9.2, 45.4835]] } },
        { name: "Via Turati", maneuver: { type: "arrive", modifier: "right" }, geometry: { coordinates: [[9.2, 45.4835], [9.2, 45.4835]] } },
      ],
    },
  ],
};
