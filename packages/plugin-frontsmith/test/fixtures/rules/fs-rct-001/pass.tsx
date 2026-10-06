import { useEffect, useState } from "react";

export function Name({ id }: { id: string }) {
  const [data, setData] = useState("");
  useEffect(() => {
    fetch(id).then(setData);
  }, [id]);
  return <span>{data}</span>;
}
