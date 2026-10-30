package worker

import "fmt"

func panicError(scope string, recovered any) error {
	return fmt.Errorf("%s panic: %v", scope, recovered)
}
