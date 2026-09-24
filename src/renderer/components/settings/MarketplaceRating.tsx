/**
 * @module renderer/components/settings/MarketplaceRating
 *
 * 技能商店评分 UI：
 * - StarDisplay：只读五星（支持半星），展示服务端平均分 + 评价次数。
 * - StarRatingInput：可点击五星，支持半星（10 档，0.5 步进）。
 *
 * 星形用 SVG 路径绘制，半星通过 clipPath 裁剪实现，避免额外依赖。
 */
import { Star } from 'lucide-react';

const STAR_COUNT = 5;

/** 把任意分数（0~5）拆成每颗星的填充比例（0 / 0.5 / 1）。 */
function fillRatios(score: number): number[] {
  const clamped = Math.min(5, Math.max(0, score || 0));
  const ratios: number[] = [];
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const remaining = clamped - i;
    if (remaining >= 1) ratios.push(1);
    else if (remaining >= 0.5) ratios.push(0.5);
    else if (remaining > 0) ratios.push(remaining);
    else ratios.push(0);
  }
  return ratios;
}

export function StarDisplay({
  score,
  size = 14,
}: {
  score: number | null;
  size?: number;
}) {
  const ratios = fillRatios(score ?? 0);
  return (
    <span className="inline-flex items-center gap-[1px] align-middle">
      {ratios.map((ratio, index) => (
        <span
          key={index}
          className="relative inline-block"
          style={{ width: size, height: size }}
        >
          <Star
            className="absolute inset-0 text-border-subtle"
            style={{ width: size, height: size }}
            strokeWidth={1.5}
            fill="currentColor"
          />
          {ratio > 0 && (
            <span
              className="absolute inset-0 overflow-hidden"
              style={{ width: `${ratio * 100}%` }}
            >
              <Star
                className="text-amber-400"
                style={{ width: size, height: size }}
                strokeWidth={1.5}
                fill="currentColor"
              />
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

export function StarRatingInput({
  value,
  hoverValue,
  disabled,
  onChange,
  onHover,
}: {
  value: number;
  hoverValue: number | null;
  disabled?: boolean;
  onChange: (score: number) => void;
  onHover: (score: number | null) => void;
}) {
  const effective = hoverValue ?? value;
  const ratios = fillRatios(effective);
  const size = 26;

  return (
    <div className="inline-flex items-center gap-1" onMouseLeave={() => onHover(null)}>
      {ratios.map((ratio, index) => {
        // 每颗星左右半边各对应一个 0.5 档
        const lowScore = index + 0.5;
        const highScore = index + 1;
        return (
          <span
            key={index}
            className="relative inline-block"
            style={{ width: size, height: size }}
          >
            <Star
              className="absolute inset-0 text-border-subtle"
              style={{ width: size, height: size }}
              strokeWidth={1.5}
              fill="currentColor"
            />
            {ratio > 0 && (
              <span
                className="absolute inset-0 overflow-hidden pointer-events-none"
                style={{ width: `${ratio * 100}%` }}
              >
                <Star
                  className="text-amber-400"
                  style={{ width: size, height: size }}
                  strokeWidth={1.5}
                  fill="currentColor"
                />
              </span>
            )}
            {!disabled && (
              <>
                <button
                  type="button"
                  aria-label={`${lowScore} 分`}
                  className="absolute inset-y-0 left-0 w-1/2 cursor-pointer"
                  onClick={() => onChange(lowScore)}
                  onMouseEnter={() => onHover(lowScore)}
                />
                <button
                  type="button"
                  aria-label={`${highScore} 分`}
                  className="absolute inset-y-0 right-0 w-1/2 cursor-pointer"
                  onClick={() => onChange(highScore)}
                  onMouseEnter={() => onHover(highScore)}
                />
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}
