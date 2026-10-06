import { create } from "zustand";

interface Project {
  id: string;
  name: string;
}

const useStore = create<{ projects: Project[] }>(() => ({ projects: [] }));

export const useProjects = () => useStore((state) => state.projects);
