import React, { useMemo } from "react";
import { View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import QRCode from "qrcode";

export function QrCode({
  value,
  size = 260,
}: {
  value: string;
  size?: number;
}) {
  const modules = useMemo(
    () => QRCode.create(value, { errorCorrectionLevel: "M" }).modules,
    [value],
  );
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < modules.size; y += 1) {
    for (let x = 0; x < modules.size; x += 1) {
      cells.push(
        <Rect
          key={`${x}-${y}`}
          x={x + 1}
          y={y + 1}
          width={1}
          height={1}
          fill={modules.get(x, y) ? "#111827" : "#ffffff"}
        />,
      );
    }
  }
  return (
    <View
      testID="sale-qr-svg"
      accessibilityRole="image"
      accessibilityLabel="QR code for payment link"
      style={{ alignItems: "center" }}
    >
      <Svg
        width={size}
        height={size}
        viewBox={`0 0 ${modules.size + 2} ${modules.size + 2}`}
      >
        {cells}
      </Svg>
    </View>
  );
}
