import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    // Relocated pi data home (gitignored; may contain whole cloned repos with
    // arbitrary lint setups) — see .env.example / scripts/adopt-pi-home.mjs.
    ignores: [".pi/agent/**", ".pi/workspaces/**"],
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
