const DEFAULT_TEST_DATABASE_URL = 'postgresql://postarix:postarix@127.0.0.1:5432/postarix_test';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}
