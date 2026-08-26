import { runProfileValidatorChild } from '../src/validator.ts'

const [profile, generationPath, installAnchor] = process.argv.slice(2)
if (profile === undefined || generationPath === undefined || installAnchor === undefined) {
  throw new Error('real validator worker requires profile, generationPath, and installAnchor')
}

await runProfileValidatorChild(profile, generationPath, installAnchor)
