export const L = ({ xs }: { xs: Array<{ id: string }> }) => <ul>{xs.map((x) => <li key={x.id}>{x.id}</li>)}</ul>;
