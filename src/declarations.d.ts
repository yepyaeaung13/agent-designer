/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';
interface Window {
  designer: import('./shared/design').DesignerApi;
}
