const write = process.stderr.write.bind(process.stderr)

process.stderr.write = (chunk, ...args) => {
  setTimeout(() => {
    write(chunk, ...args)
  }, 25)
  return false
}
