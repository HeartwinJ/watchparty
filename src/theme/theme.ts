import {
  createTheme,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from "@mantine/core";

/**
 * Mantine theme for the redesign: dark-only, copper accent. CSS custom properties live in
 * tokens.css (`--wp-*`); this file maps them onto Mantine so its components match.
 */

// Index 5 is the accent (#c66b3d). Its luminance (~0.23) is above the 0.2 threshold below,
// so autoContrast gives filled copper buttons dark text (white on copper fails contrast).
export const copper: MantineColorsTuple = [
  "#fbf1eb",
  "#f3dccd",
  "#e9bfa5",
  "#dea07b",
  "#d4865a",
  "#c66b3d",
  "#a95830",
  "#8a4625",
  "#6b351b",
  "#4d2512",
];

// Neutral greys matching the surfaces in tokens.css (Mantine uses `dark` for dark-scheme UI)
const dark: MantineColorsTuple = [
  "#eceef2",
  "#a9aeba",
  "#8a909c",
  "#5c6270",
  "#363b47",
  "#262a33",
  "#22252d",
  "#191c22",
  "#121419",
  "#0b0c0f",
];

export const theme = createTheme({
  colors: { copper, dark },
  primaryColor: "copper",
  primaryShade: 5,
  autoContrast: true,
  luminanceThreshold: 0.2,
  black: "#1b0f08",
  white: "#eceef2",
  fontFamily: "var(--wp-font)",
  fontFamilyMonospace: "var(--wp-font-mono)",
  defaultRadius: "md",
  radius: { xs: "4px", sm: "6px", md: "10px", lg: "14px", xl: "20px" },
  spacing: { xs: "8px", sm: "12px", md: "16px", lg: "24px", xl: "32px" },
  fontSizes: { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "20px" },
  breakpoints: { xs: "36em", sm: "48em", md: "60em", lg: "75em", xl: "88em" },
  shadows: {
    xs: "var(--wp-sh-1)",
    sm: "var(--wp-sh-1)",
    md: "var(--wp-sh-2)",
    lg: "var(--wp-sh-3)",
    xl: "var(--wp-sh-3)",
  },
  headings: { fontWeight: "700" },
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {},
  dark: {
    "--mantine-color-body": "var(--wp-bg)",
    "--mantine-color-text": "var(--wp-text)",
    "--mantine-color-dimmed": "var(--wp-text-3)",
    "--mantine-color-default": "var(--wp-surface-2)",
    "--mantine-color-default-hover": "var(--wp-surface-3)",
    "--mantine-color-default-border": "var(--wp-border-strong)",
    "--mantine-color-placeholder": "var(--wp-text-3)",
    "--mantine-color-anchor": "var(--wp-accent-text)",
    "--mantine-color-error": "var(--wp-danger)",
  },
});
