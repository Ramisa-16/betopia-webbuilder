import { describe, it, expect } from 'vitest'
import { buildDatabaseSetupPrompt, extractDatabaseConnectionMatch } from '../database'

describe('database connection helpers', () => {
  it('extracts a postgres connection string', () => {
    const match = extractDatabaseConnectionMatch('connect this project to postgresql://user:pass@db.example.com:5432/appdb')
    expect(match?.kind).toBe('postgres-url')
    expect(match?.provider).toBe('postgres')
    expect(match?.secretKey).toBe('DATABASE_URL')
    expect(match?.databaseUrl).toBe('postgresql://user:pass@db.example.com:5432/appdb')
    expect(match?.needsCredentials).toBe(false)
  })

  it('extracts a supabase project url and flags missing credentials', () => {
    const match = extractDatabaseConnectionMatch('use my Supabase https://abc123.supabase.co project')
    expect(match?.kind).toBe('supabase-project-url')
    expect(match?.provider).toBe('supabase')
    expect(match?.secretKey).toBe('SUPABASE_URL')
    expect(match?.projectUrl).toBe('https://abc123.supabase.co')
    expect(match?.needsCredentials).toBe(true)
  })

  it('extracts mysql connection strings', () => {
    const match = extractDatabaseConnectionMatch('connect mysql://user:pass@db.example.com:3306/appdb')
    expect(match?.kind).toBe('mysql-url')
    expect(match?.provider).toBe('mysql')
    expect(match?.secretKey).toBe('MYSQL_URL')
  })

  it('extracts mongodb connection strings', () => {
    const match = extractDatabaseConnectionMatch('connect mongodb+srv://user:pass@cluster.example.com/appdb')
    expect(match?.kind).toBe('mongodb-url')
    expect(match?.provider).toBe('mongodb')
    expect(match?.secretKey).toBe('MONGODB_URI')
    expect(match?.connectionType).toBe('cloud-managed')
  })

  it('extracts sqlite file paths', () => {
    const match = extractDatabaseConnectionMatch('use /tmp/app.sqlite for local storage', 'sqlite')
    expect(match?.kind).toBe('sqlite-file')
    expect(match?.provider).toBe('sqlite')
    expect(match?.secretKey).toBe('SQLITE_DATABASE_URL')
  })

  it('extracts sqlite file urls', () => {
    const match = extractDatabaseConnectionMatch('use file:///tmp/app.sqlite for local storage')
    expect(match?.kind).toBe('sqlite-url')
    expect(match?.provider).toBe('sqlite')
    expect(match?.secretKey).toBe('SQLITE_DATABASE_URL')
  })

  it('builds a database setup prompt for postgres urls', () => {
    const match = extractDatabaseConnectionMatch('postgresql://user:pass@db.example.com:5432/appdb')!
    const prompt = buildDatabaseSetupPrompt(match)
    expect(prompt).toContain('[INTENT: DATABASE_SETUP]')
    expect(prompt).toContain('DATABASE_URL')
  })

  it('builds provider-specific setup prompts', () => {
    const match = extractDatabaseConnectionMatch('mysql://user:pass@db.example.com:3306/appdb')!
    const prompt = buildDatabaseSetupPrompt(match)
    expect(prompt).toContain('MYSQL_URL')
    expect(prompt).toContain('Provider: mysql')
  })
})
