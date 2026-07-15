// Workspace-only glue for docs-style Gherkin specs.
// This keeps Cucumber language-server diagnostics quiet even when
// scenarios are not executed by a Cucumber test runner.
Given(/^.*$/, () => {})
When(/^.*$/, () => {})
Then(/^.*$/, () => {})
