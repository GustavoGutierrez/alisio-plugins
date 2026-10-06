const colors = { blue: "bg-blue-600", red: "bg-red-600" };
export const A = ({ color }: { color: "blue" | "red" }) => <div className={colors[color]} />;
