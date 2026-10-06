interface Props {
  a: boolean;
  b: boolean;
  c: boolean;
  d: boolean;
}
export function Chip(props: Props) {
  return <span>{String(props.a)}</span>;
}
