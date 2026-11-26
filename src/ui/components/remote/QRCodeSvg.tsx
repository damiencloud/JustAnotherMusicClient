import React, { useMemo } from "react";
import { generateQrMatrix } from "./qrCode";

interface QRCodeSvgProps {
  value: string;
  size?: number;
  fgColor?: string;
  bgColor?: string;
  margin?: number;
  className?: string;
}

export const QRCodeSvg: React.FC<QRCodeSvgProps> = ({
  value,
  size = 180,
  fgColor = "#000000",
  bgColor = "#ffffff",
  margin = 3,
  className,
}) => {
  const { matrix, viewBoxSize } = useMemo(() => {
    try {
      const mat = generateQrMatrix(value);
      const mSize = mat.length;
      return { matrix: mat, viewBoxSize: mSize + margin * 2 };
    } catch {
      return { matrix: [], viewBoxSize: 25 };
    }
  }, [value, margin]);

  if (!matrix.length) {
    return <div style={{ width: size, height: size, background: bgColor }} />;
  }

  const rects: React.ReactNode[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      if (matrix[r][c]) {
        rects.push(
          <rect
            key={`${r}-${c}`}
            x={c + margin}
            y={r + margin}
            width={1}
            height={1}
            fill={fgColor}
          />
        );
      }
    }
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      style={{ display: "block", borderRadius: "10px", background: bgColor, padding: "8px" }}
    >
      <rect width="100%" height="100%" fill={bgColor} />
      {rects}
    </svg>
  );
};
