package auth

import "github.com/postwave/postwave/services/deliverability/internal/domain"

func ok(detail string) domain.AuthRecord {
	return domain.AuthRecord{Status: domain.AuthOK, Detail: detail}
}
func warn(detail string) domain.AuthRecord {
	return domain.AuthRecord{Status: domain.AuthWarn, Detail: detail}
}
func fail(detail string) domain.AuthRecord {
	return domain.AuthRecord{Status: domain.AuthFail, Detail: detail}
}
