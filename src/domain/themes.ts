export const THEMES = [
  { id: 'system', label: '跟隨系統', description: '隨系統切換明暗', scheme: 'system' },
  { id: 'light', label: '晨光', description: '柔白 · 鼠尾草綠', scheme: 'light' },
  { id: 'dark', label: '夜間', description: '深灰 · 柔和綠', scheme: 'dark' },
  { id: 'forest', label: '森林', description: '墨綠 · 暖金', scheme: 'dark' },
  { id: 'ocean', label: '海灣', description: '深海藍 · 青碧', scheme: 'dark' },
  { id: 'slate', label: '石墨', description: '石板灰 · 冰藍', scheme: 'dark' },
  { id: 'sand', label: '暖砂', description: '米杏 · 陶土', scheme: 'light' },
  { id: 'rose', label: '玫瑰', description: '霧粉 · 莓紅', scheme: 'light' },
  { id: 'lavender', label: '紫藤', description: '淡紫 · 鳶尾', scheme: 'light' },
] as const;

export function themeScheme(theme: string): 'system' | 'light' | 'dark' {
  return THEMES.find((entry) => entry.id === theme)?.scheme ?? 'system';
}

export function validTheme(theme: unknown): string {
  return THEMES.find((entry) => entry.id === theme)?.id ?? 'system';
}
