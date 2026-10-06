interface Props {
  a: boolean;
  b: boolean;
  c: boolean;
  d: boolean;
  e: boolean;
}
export function Chip(props: Props) {
  return <span>{String(props.a)}</span>;
}
