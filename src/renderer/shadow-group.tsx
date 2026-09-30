import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Group, Image as CanvasImage } from 'react-konva';
import Konva from 'konva';
import type { DesignNode } from '../shared/design';

const ImageReady = createContext<() => void>(() => {});
export const useShadowImageReady = () => useContext(ImageReady);

export function ShadowGroup({
  shadow,
  children,
}: {
  shadow: DesignNode['shadow'];
  children: ReactNode;
}) {
  const content = useRef<Konva.Group>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const parentReady = useShadowImageReady();
  const ready = useCallback(() => {
    setImageVersion((value) => value + 1);
    parentReady();
  }, [parentReady]);
  const [rendered, setRendered] = useState<{
    image: HTMLCanvasElement;
    x: number;
    y: number;
    width: number;
    height: number;
  }>();
  useEffect(() => {
    const group = content.current;
    if (!group || !shadow?.enabled) {
      setRendered(undefined);
      return;
    }
    const bounds = group.getClientRect({ skipTransform: true });
    if (!bounds.width || !bounds.height) {
      setRendered(undefined);
      return;
    }
    const padding = Math.ceil(
      shadow.blur * 2 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) + 2,
    );
    const x = bounds.x - padding,
      y = bounds.y - padding;
    const width = bounds.width + padding * 2,
      height = bounds.height + padding * 2;
    const ratio = Math.min(1, 4096 / Math.max(width, height));
    // A detached copy renders in local coordinates, independent of pan/zoom and ancestors.
    const copy = group.clone();
    const source = copy.toCanvas({ x, y, width, height, pixelRatio: ratio });
    copy.destroy();
    const image = document.createElement('canvas');
    image.width = source.width;
    image.height = source.height;
    const ctx = image.getContext('2d')!;
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur * ratio;
    ctx.shadowOffsetX = shadow.x * ratio;
    ctx.shadowOffsetY = shadow.y * ratio;
    ctx.drawImage(source, 0, 0);
    // Remove the source silhouette, leaving only the shadow behind the live children.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(source, 0, 0);
    setRendered({ image, x, y, width, height });
  }, [children, shadow, imageVersion]);
  return (
    <ImageReady.Provider value={ready}>
      {rendered && shadow?.enabled && (
        <CanvasImage
          image={rendered.image}
          x={rendered.x}
          y={rendered.y}
          width={rendered.width}
          height={rendered.height}
          opacity={shadow.opacity}
          listening={false}
        />
      )}
      <Group ref={content}>{children}</Group>
    </ImageReady.Provider>
  );
}
