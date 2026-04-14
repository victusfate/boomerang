// vite.config.ts
import { defineConfig } from "file:///C:/Users/messel/Desktop/Dropbox/code/js/boomerang/news-feed/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/messel/Desktop/Dropbox/code/js/boomerang/news-feed/node_modules/@vitejs/plugin-react/dist/index.js";
import { VitePWA } from "file:///C:/Users/messel/Desktop/Dropbox/code/js/boomerang/news-feed/node_modules/vite-plugin-pwa/dist/index.js";
var base = process.env.GITHUB_PAGES === "true" ? "/boomerang" : "/";
var vite_config_default = defineConfig({
  base,
  // Preview must use the same `base` as the build (set GITHUB_PAGES=true for gh-pages preview).
  preview: {
    open: base === "/boomerang" ? "/boomerang" : "/"
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Boomerang News",
        short_name: "News",
        description: "Algorithmic news feed without ads",
        theme_color: "#111111",
        background_color: "#111111",
        display: "standalone",
        orientation: "portrait",
        start_url: base,
        scope: base,
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png}"]
        // RSS is fetched only via Cloudflare Worker (VITE_RSS_WORKER_URL); no RSS proxy caching.
      }
    })
  ]
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxtZXNzZWxcXFxcRGVza3RvcFxcXFxEcm9wYm94XFxcXGNvZGVcXFxcanNcXFxcYm9vbWVyYW5nXFxcXG5ld3MtZmVlZFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcbWVzc2VsXFxcXERlc2t0b3BcXFxcRHJvcGJveFxcXFxjb2RlXFxcXGpzXFxcXGJvb21lcmFuZ1xcXFxuZXdzLWZlZWRcXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0M6L1VzZXJzL21lc3NlbC9EZXNrdG9wL0Ryb3Bib3gvY29kZS9qcy9ib29tZXJhbmcvbmV3cy1mZWVkL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnO1xuaW1wb3J0IHsgVml0ZVBXQSB9IGZyb20gJ3ZpdGUtcGx1Z2luLXB3YSc7XG5cbi8qKiBHaXRIdWIgcHJvamVjdCBzaXRlIHBhdGg7IG5vIHRyYWlsaW5nIHNsYXNoIHNvIHRoZSBjYW5vbmljYWwgVVJMIGlzIFx1MjAyNi9ib29tZXJhbmcgbm90IFx1MjAyNi9ib29tZXJhbmcvICovXG5jb25zdCBiYXNlID0gcHJvY2Vzcy5lbnYuR0lUSFVCX1BBR0VTID09PSAndHJ1ZScgPyAnL2Jvb21lcmFuZycgOiAnLyc7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIGJhc2UsXG4gIC8vIFByZXZpZXcgbXVzdCB1c2UgdGhlIHNhbWUgYGJhc2VgIGFzIHRoZSBidWlsZCAoc2V0IEdJVEhVQl9QQUdFUz10cnVlIGZvciBnaC1wYWdlcyBwcmV2aWV3KS5cbiAgcHJldmlldzoge1xuICAgIG9wZW46IGJhc2UgPT09ICcvYm9vbWVyYW5nJyA/ICcvYm9vbWVyYW5nJyA6ICcvJyxcbiAgfSxcbiAgcGx1Z2luczogW1xuICAgIHJlYWN0KCksXG4gICAgVml0ZVBXQSh7XG4gICAgICByZWdpc3RlclR5cGU6ICdhdXRvVXBkYXRlJyxcbiAgICAgIGluY2x1ZGVBc3NldHM6IFsnZmF2aWNvbi5zdmcnLCAnaWNvbi0xOTIucG5nJywgJ2ljb24tNTEyLnBuZyddLFxuICAgICAgbWFuaWZlc3Q6IHtcbiAgICAgICAgbmFtZTogJ0Jvb21lcmFuZyBOZXdzJyxcbiAgICAgICAgc2hvcnRfbmFtZTogJ05ld3MnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FsZ29yaXRobWljIG5ld3MgZmVlZCB3aXRob3V0IGFkcycsXG4gICAgICAgIHRoZW1lX2NvbG9yOiAnIzExMTExMScsXG4gICAgICAgIGJhY2tncm91bmRfY29sb3I6ICcjMTExMTExJyxcbiAgICAgICAgZGlzcGxheTogJ3N0YW5kYWxvbmUnLFxuICAgICAgICBvcmllbnRhdGlvbjogJ3BvcnRyYWl0JyxcbiAgICAgICAgc3RhcnRfdXJsOiBiYXNlLFxuICAgICAgICBzY29wZTogYmFzZSxcbiAgICAgICAgaWNvbnM6IFtcbiAgICAgICAgICB7IHNyYzogJ2ljb24tMTkyLnBuZycsIHNpemVzOiAnMTkyeDE5MicsIHR5cGU6ICdpbWFnZS9wbmcnLCBwdXJwb3NlOiAnYW55IG1hc2thYmxlJyB9LFxuICAgICAgICAgIHsgc3JjOiAnaWNvbi01MTIucG5nJywgc2l6ZXM6ICc1MTJ4NTEyJywgdHlwZTogJ2ltYWdlL3BuZycsIHB1cnBvc2U6ICdhbnkgbWFza2FibGUnIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAgd29ya2JveDoge1xuICAgICAgICBnbG9iUGF0dGVybnM6IFsnKiovKi57anMsY3NzLGh0bWwsc3ZnLHBuZ30nXSxcbiAgICAgICAgLy8gUlNTIGlzIGZldGNoZWQgb25seSB2aWEgQ2xvdWRmbGFyZSBXb3JrZXIgKFZJVEVfUlNTX1dPUktFUl9VUkwpOyBubyBSU1MgcHJveHkgY2FjaGluZy5cbiAgICAgIH0sXG4gICAgfSksXG4gIF0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBcVgsU0FBUyxvQkFBb0I7QUFDbFosT0FBTyxXQUFXO0FBQ2xCLFNBQVMsZUFBZTtBQUd4QixJQUFNLE9BQU8sUUFBUSxJQUFJLGlCQUFpQixTQUFTLGVBQWU7QUFFbEUsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUI7QUFBQTtBQUFBLEVBRUEsU0FBUztBQUFBLElBQ1AsTUFBTSxTQUFTLGVBQWUsZUFBZTtBQUFBLEVBQy9DO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixRQUFRO0FBQUEsTUFDTixjQUFjO0FBQUEsTUFDZCxlQUFlLENBQUMsZUFBZSxnQkFBZ0IsY0FBYztBQUFBLE1BQzdELFVBQVU7QUFBQSxRQUNSLE1BQU07QUFBQSxRQUNOLFlBQVk7QUFBQSxRQUNaLGFBQWE7QUFBQSxRQUNiLGFBQWE7QUFBQSxRQUNiLGtCQUFrQjtBQUFBLFFBQ2xCLFNBQVM7QUFBQSxRQUNULGFBQWE7QUFBQSxRQUNiLFdBQVc7QUFBQSxRQUNYLE9BQU87QUFBQSxRQUNQLE9BQU87QUFBQSxVQUNMLEVBQUUsS0FBSyxnQkFBZ0IsT0FBTyxXQUFXLE1BQU0sYUFBYSxTQUFTLGVBQWU7QUFBQSxVQUNwRixFQUFFLEtBQUssZ0JBQWdCLE9BQU8sV0FBVyxNQUFNLGFBQWEsU0FBUyxlQUFlO0FBQUEsUUFDdEY7QUFBQSxNQUNGO0FBQUEsTUFDQSxTQUFTO0FBQUEsUUFDUCxjQUFjLENBQUMsNEJBQTRCO0FBQUE7QUFBQSxNQUU3QztBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
