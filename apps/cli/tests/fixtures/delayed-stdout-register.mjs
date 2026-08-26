const write = process.stdout.write.bind(process.stdout)

process.stdout.write = (chunk, ...args) => {
  setTimeout(() => {
    write(chunk, ...args)
  }, 25)
  return false
}
