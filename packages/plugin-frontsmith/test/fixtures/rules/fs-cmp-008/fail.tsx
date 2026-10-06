export const L = ({ xs }: { xs: string[] }) => <ul>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul>;
