---
name: test
description: Generate comprehensive tests for code and features. Use when writing new tests or improving test coverage for a behavior, bug fix, or regression.
origin: Betopia
slash: /test
order: 90
---

# Write Tests

When writing tests, follow these guidelines:

1. Cover the happy path first.
2. Cover edge cases, including empty inputs and boundary values.
3. Cover error paths.
4. Use one assertion per test where possible.
5. Prefer descriptive test names.
6. Test behavior, not implementation details.
7. Use realistic test data.
8. Mock external dependencies like network, database, and filesystem.

Preferred test structure:

```text
describe('<ComponentOrFunction>', () => {
  it('<expected behaviour> when <condition>', () => {
    // Arrange
    // Act
    // Assert
  })
})
```

Aim for at least 1 happy path, 2 edge cases, and 1 error case per function.
