import type { Memory, Project } from '../../shared/schemas'
import { keywords, normalizeForComparison } from '../../shared/text'

export interface ProjectClassification {
  projectId: string
  confidence: number
  reason: string
}

export function classifyProject(
  text: string,
  projects: Project[],
  memories: Memory[] = []
): ProjectClassification | null {
  const input = keywords(text)
  if (input.size === 0 || projects.length === 0) return null
  const ranked = projects
    .map((project) => {
      const projectMemories = memories
        .filter((memory) => memory.project_id === project.project_id && memory.state !== 'deleted')
        .slice(0, 50)
      const seedText = [
        project.name,
        project.description,
        ...projectMemories.map((memory) => memory.statement)
      ].join(' ')
      const seed = keywords(seedText)
      const matching = [...input].filter((word) => seed.has(word))
      const exactName = normalizeForComparison(text).includes(normalizeForComparison(project.name))
      const denominator = Math.max(1, Math.min(input.size, Math.max(seed.size, 1)))
      const lexical = matching.length / denominator
      const confidence = Math.min(1, lexical + (exactName ? 0.45 : 0))
      return { project, confidence, matching, exactName }
    })
    .sort((left, right) => right.confidence - left.confidence)
  const best = ranked[0]
  const runnerUp = ranked[1]
  if (!best) return null
  const enoughEvidence = best.exactName || best.matching.length >= 2
  const separated = !runnerUp || best.confidence - runnerUp.confidence >= 0.08
  if (!enoughEvidence || !separated || best.confidence < 0.2) return null
  return {
    projectId: best.project.project_id,
    confidence: Number(best.confidence.toFixed(3)),
    reason: best.exactName
      ? `Exact project-name match: ${best.project.name}`
      : `Matched project terms: ${best.matching.slice(0, 6).join(', ')}`
  }
}
