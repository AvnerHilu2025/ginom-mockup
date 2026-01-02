// frontend/constants.js

export const SECTORS = {
  electricity: {
    label: "Electricity",
    color: "#1E42AC" // blue
  },
  water: {
    label: "Water",
    color: "#0EA5E9" // light blue
  },
  gas: {
    label: "Gas",
    color: "#F97316" // amber
  },
  communication: {
    label: "Communication",
    color: "#8B5CF6" // purple
  },
  first_responders: {
    label: "First Responders",
    color: "#DC2626" // red
  }
};

export const ASSET_STATUS = {
  ok: {
    label: "Operational",
    color: "#16A34A" // green
  },
  degraded: {
    label: "Degraded",
    color: "#F97316" // orange
  },
  failed: {
    label: "Failed",
    color: "#DC2626" // red
  },
  recovered: {
    label: "Recovered",
    color: "#22C55E" // green bright
  }
};
