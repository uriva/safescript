replaceAllByDefault = () => {
  replaced = stringReplace({ haystack: "one two one", needle: "one", replacement: "three" })
  assert({ condition: replaced.result == "three two three", message: "expected all matches to be replaced by default" })
  assert({ condition: replaced.count == 2, message: "expected count to include all matches" })
  return true
}

replaceFirstWhenAllFalse = () => {
  replaced = stringReplace({ haystack: "one two one", needle: "one", replacement: "three", all: false })
  assert({ condition: replaced.result == "three two one", message: "expected only first match to be replaced" })
  assert({ condition: replaced.count == 2, message: "expected count to include all matches even when replacing first" })
  return true
}

reportsZeroMatches = () => {
  replaced = stringReplace({ haystack: "one two", needle: "missing", replacement: "three" })
  assert({ condition: replaced.result == "one two", message: "expected unchanged text when no matches" })
  assert({ condition: replaced.count == 0, message: "expected zero match count" })
  return true
}
