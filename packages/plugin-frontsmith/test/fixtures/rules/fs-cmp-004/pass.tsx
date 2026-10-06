import { forwardRef } from "react";

export const Input = forwardRef<HTMLInputElement, { value: string }>(function Input(props, ref) {
  return <input ref={ref} value={props.value} />;
});
