.PHONY: all lint test test-scripts check package-verify verify

all: lint test test-scripts

lint:
	npm run lint

test:
	npm test

test-scripts:
	npm run test:scripts

check:
	npm run check

# Isolated consumer install plus a real Pi host load from the packed artifact.
package-verify:
	npm run verify:package

verify: all package-verify
