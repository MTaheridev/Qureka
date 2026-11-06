type BrandLogoProps = {
  className?: string;
  size?: number;
};

/** App mark — `public/logo.png` (relative URL for Electron `file://`). */
export function BrandLogo({ className, size }: BrandLogoProps) {
  return (
    <img
      className={className}
      src="./logo.png"
      alt=""
      width={size}
      height={size}
      draggable={false}
    />
  );
}
