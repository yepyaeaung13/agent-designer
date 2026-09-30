import {
  useEffect,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';

export function useRightPan(
  viewport: RefObject<HTMLDivElement | null>,
  setPan: Dispatch<SetStateAction<{ x: number; y: number }>>,
) {
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let pointer: { x: number; y: number } | null = null;
    const stop = () => {
      pointer = null;
      element.classList.remove('right-panning');
    };
    const down = (event: MouseEvent) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      pointer = { x: event.clientX, y: event.clientY };
      element.classList.add('right-panning');
    };
    const move = (event: MouseEvent) => {
      if (!pointer) return;
      if (!(event.buttons & 2)) {
        stop();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer = { x: event.clientX, y: event.clientY };
      setPan((previous) => ({ x: previous.x + dx, y: previous.y + dy }));
    };
    const up = (event: MouseEvent) => {
      if (!pointer || event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      stop();
    };
    const menu = (event: MouseEvent) => event.preventDefault();
    // Capture before Konva sees right-clicks on layers or transform handles.
    element.addEventListener('mousedown', down, true);
    element.addEventListener('contextmenu', menu);
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('blur', stop);
    return () => {
      stop();
      element.removeEventListener('mousedown', down, true);
      element.removeEventListener('contextmenu', menu);
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', stop);
    };
  }, [viewport, setPan]);
}
