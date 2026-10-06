import { useProjects } from "@/entities/project";
import { Card } from "@/shared/ui/card";
import styles from "./ProjectList.module.css";

export function ProjectList() {
  const projects = useProjects();
  return (
    <ul className={styles.list}>
      {projects.map((project) => (
        <li key={project.id}>
          <Card title={project.name} />
        </li>
      ))}
    </ul>
  );
}
