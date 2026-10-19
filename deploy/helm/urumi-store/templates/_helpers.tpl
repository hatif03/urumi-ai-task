{{- define "store.bunSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
readOnlyRootFilesystem: true
{{- end -}}

{{- define "store.labels" -}}
app.kubernetes.io/part-of: urumi-store
app.kubernetes.io/instance: {{ .Release.Name }}
urumi.io/store: {{ .Values.store.slug | quote }}
{{- end -}}
