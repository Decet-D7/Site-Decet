// Ponte entre a sala (JS puro, js/meet-board.js) e o Excalidraw (React).
// Gera js/vendor/excalidraw/board.js com `npm run build` nesta pasta.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {
  Excalidraw, MainMenu, CaptureUpdateAction, reconcileElements, restoreElements,
  convertToExcalidrawElements, newElementWith, exportToBlob,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// Monta a lousa em `container`. Callbacks: onReady(api), onChange(elements, appState, files),
// onPointerUpdate(payload), onClearAll(). Devolve uma função que desmonta.
export function mountBoard(container, options) {
  const {elements = [], files = [], onReady, onChange, onPointerUpdate, onClearAll} = options;
  const root = createRoot(container);
  root.render(
    <Excalidraw
      excalidrawAPI={onReady}
      initialData={{
        elements,
        files: Object.fromEntries(files.map(file => [file.id, file])),
        appState: {viewBackgroundColor: '#ffffff'},
        scrollToContent: elements.length > 0,
      }}
      onChange={onChange}
      onPointerUpdate={onPointerUpdate}
      isCollaborating={true}
      theme="dark"
      langCode="pt-BR"
      UIOptions={{
        canvasActions: {loadScene: false, saveToActiveFile: false, export: false, clearCanvas: false, toggleTheme: false, saveAsImage: true, changeViewBackgroundColor: true},
      }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.Separator />
        <MainMenu.Item onSelect={onClearAll}>Limpar a lousa para todos</MainMenu.Item>
        <MainMenu.Separator />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
    </Excalidraw>,
  );
  return () => root.unmount();
}

export {CaptureUpdateAction, reconcileElements, restoreElements, convertToExcalidrawElements, newElementWith, exportToBlob};

// Carregados só quando usados (pedaços separados): calculadora das caixas de texto e gráficos extras.
export const loadMath = () => import('./math.js');
export const loadChart = () => import('chart.js/auto').then(module => module.default);
