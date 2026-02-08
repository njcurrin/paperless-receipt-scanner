package local_db

import (
	//"errors"
	//"os"
	//"path/filepath"
	"time"
	//"gorm.io/driver/sqlite"
	//"gorm.io/gorm"
	//"github.com/sirupsen/logrus"
)

// CustomField represents a custom field from the Paperless-ngx API
type CustomField struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	DataType string `json:"data_type"`
}

// ModificationHistory represents the schema of the modification_history table
type ModificationHistory struct {
	ID            uint   `gorm:"primaryKey"`             // Auto-incrementing primary key
	DocumentID    uint   `gorm:"not null"`               // Foreign key to documents table (if applicable)
	DateChanged   string `gorm:"not null"`               // Date and time of modification
	ModField      string `gorm:"size:255;not null"`      // Field being modified
	PreviousValue string `gorm:"size:1048576"`           // Previous value of the field
	NewValue      string `gorm:"size:1048576"`           // New value of the field
	Undone        bool   `gorm:"not null;default:false"` // Whether the modification has been undone
	UndoneDate    string `gorm:"default:null"`           // Date and time of undoing the modification
}

type OCRPageResult struct {
	ID             uint   `gorm:"primaryKey"`
	DocumentID     int    `gorm:"index;not null"`
	PageIndex      int    `gorm:"not null"`
	Text           string `gorm:"size:1048576"`
	OcrLimitHit    bool
	GenerationInfo string `gorm:"type:TEXT"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type Result struct {
	ID             uint   `gorm:"primaryKey"`
	DocumentID     int    `gorm:"index;not null"`
	VLMOCR         string `gorm:"size:1048576"`
	Title          string `gorm:"size:255;not null"`
	OcrLimitHit    bool
	GenerationInfo string `gorm:"type:TEXT"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type Receipt struct {
	ID             uint          `gorm:"primaryKey"`
	DocumentID     int           `gorm:"index;not null"`
	Title          string        `gorm:"type:TEXT"`
	Payee          string        `gorm:"size:255"`
	PageIndex      int           `gorm:"not null"`
	TradOCR        string        `gorm:"size:1048576"`
	TotalTender    int64         `gorm:"index;not null"`
	ItemsSold      int           `gorm:"index;not null"`
	TaxCents       int           `gorm:"index"`
	ResultID       *uint         `gorm:"index"`
	Cart           []ReceiptItem `gorm:"type:json"`
	OcrLimitHit    bool
	GenerationInfo string `gorm:"type:TEXT"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type ReceiptItem struct {
	ID             uint   `gorm:"primaryKey"`
	Title          string `gorm:"size:255"`
	GeneratedName  string `gorm:"size:255"`
	Cost           int    `gorm:"not null"`
	Category       string `gorm:"size:255;index;not null"`
	GenerationInfo string `gorm:"type:TEXT"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}
