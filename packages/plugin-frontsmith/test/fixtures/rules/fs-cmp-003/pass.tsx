import type { ComponentPropsWithoutRef, ElementType } from "react";

type Props<T extends ElementType> = { as?: T } & ComponentPropsWithoutRef<T>;

export function Box<T extends ElementType = "div">({ as, ...rest }: Props<T>) {
  const Tag = as ?? "div";
  return <Tag {...rest} />;
}
