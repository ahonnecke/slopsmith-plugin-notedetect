/**
 * Tailwind build config for note_detect's OWN stylesheet.
 *
 * Slopsmith core serves Tailwind as a prebuilt stylesheet and only scans CORE
 * source (constitution Principle II — no Play CDN / runtime JIT). This plugin
 * uses arbitrary values (z-[150], z-[200], z-[99999], text-[10px],
 * max-h-[calc(...)]) that no "complete" Tailwind set contains, so without its
 * own scanned sheet the gear popover, HUD, and end-of-song summary render
 * unstyled / wrong-stacked and look broken. This sheet fixes all of them.
 *
 * Regenerate assets/plugin.css with:  bash build-tailwind.sh
 * (bump plugin.json `version` so the injected <link>'s ?v= refetches it)
 */
module.exports = {
    // Core ships the single base reset; emit utilities only.
    corePlugins: { preflight: false },
    content: [
        './screen.js',
        './settings.html',
    ],
    theme: {
        extend: {
            // Mirror core's theme tokens so bg-dark-700 / accent / gold compile.
            colors: {
                dark: { 900: '#050508', 800: '#0a0a12', 700: '#10101e', 600: '#181830', 500: '#1e1e3a' },
                accent: { DEFAULT: '#4080e0', light: '#60a0ff', dark: '#2060b0' },
                gold: '#e8c040',
            },
            fontFamily: {
                display: ['"Inter"', 'system-ui', 'sans-serif'],
            },
        },
    },
    safelist: [
        { pattern: /^(bg|text|border)-(dark|accent)(-.+)?$/ },
    ],
    plugins: [],
};
