/**
 * "Step into this outline" silhouette for the guided photo session — a
 * soft white figure drawn over the live preview so the patient can see
 * from six feet away whether they are centered and sized right. Front and
 * back use the same facing silhouette (they look identical from the
 * camera); the side pose gets a narrower profile column.
 *
 * Drawn as SVG paths (not a generated image) so the overlay stays crisp
 * at any preview size and tints with a single opacity.
 */
import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import type { SessionAngle } from '@/lib/progress-session';

const STROKE = 'rgba(255, 255, 255, 0.9)';
const FILL = 'rgba(255, 255, 255, 0.07)';

/** Facing silhouette: shoulders, arms held slightly out, legs with a gap. */
const FRONT_BODY =
  'M84 70 C70 76 59 82 53 97 C47 112 45 128 41 150 ' +
  'C38 166 33 182 35 190 C38 197 47 197 50 189 C55 176 59 160 63 147 ' +
  'L63 200 C63 232 65 264 69 292 C72 314 73 336 73 354 ' +
  'L90 354 C90 334 91 312 95 288 C97 276 99 264 100 252 ' +
  'C101 264 103 276 105 288 C109 312 110 334 110 354 ' +
  'L127 354 C127 336 128 314 131 292 C135 264 137 232 137 200 ' +
  'L137 147 C141 160 145 176 150 189 C153 197 162 197 165 190 ' +
  'C167 182 162 166 159 150 C155 128 153 112 147 97 ' +
  'C141 82 130 76 116 70 Z';

/** Side profile: one narrower column, arms hanging within the body line. */
const SIDE_BODY =
  'M93 68 C84 74 79 83 77 94 C75 105 76 116 79 128 ' +
  'L84 152 C86 168 86 184 85 200 C84 232 86 264 90 292 ' +
  'C93 314 94 336 94 354 L114 354 C114 336 115 314 116 292 ' +
  'C119 260 120 228 118 196 C117 180 115 164 115 152 ' +
  'L118 128 C121 116 122 105 120 94 C118 83 112 74 103 68 Z';

interface BodyOutlineProps {
  angle: SessionAngle;
  /** Rendered height in px; width follows the 1:2 viewBox ratio. */
  height: number;
}

export function BodyOutline({ angle, height }: BodyOutlineProps) {
  const side = angle === 'side';
  return (
    <Svg
      testID={`body-outline-${angle}`}
      viewBox="0 0 200 400"
      width={height / 2}
      height={height}
      pointerEvents="none"
    >
      <Circle
        cx={side ? 101 : 100}
        cy={42}
        r={24}
        stroke={STROKE}
        strokeWidth={3}
        fill={FILL}
      />
      <Path
        d={side ? SIDE_BODY : FRONT_BODY}
        stroke={STROKE}
        strokeWidth={3}
        strokeLinejoin="round"
        fill={FILL}
      />
    </Svg>
  );
}
