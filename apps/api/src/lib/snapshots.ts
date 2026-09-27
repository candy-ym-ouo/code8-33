import type { Book, CompletionReflection, DogEar, Annotation, RereadMark } from '@prisma/client';

/**
 * 写入事件时随载荷保存的实体快照。
 * 快照让存量事件可以脱离当前行状态独立重放，
 * 也是旧客户端省略版本号时做内容比对的依据。
 */

export function bookSnapshot(book: Book): Record<string, unknown> {
  return {
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    publicationYear: book.publicationYear,
    isbn: book.isbn,
    pageCount: book.pageCount,
    coverUrl: book.coverUrl,
    status: book.status
  };
}

export function dogEarSnapshot(dogEar: DogEar): Record<string, unknown> {
  return {
    pageNumber: dogEar.pageNumber,
    reason: dogEar.reason
  };
}

export function annotationSnapshot(annotation: Annotation): Record<string, unknown> {
  return {
    startPage: annotation.startPage,
    endPage: annotation.endPage,
    content: annotation.content
  };
}

export function rereadMarkSnapshot(mark: RereadMark): Record<string, unknown> {
  return {
    pageNumber: mark.pageNumber,
    reason: mark.reason
  };
}

export function reflectionSnapshot(reflection: CompletionReflection): Record<string, unknown> {
  return {
    completionRound: reflection.completionRound,
    moodTags: reflection.moodTags,
    reflection: reflection.reflection,
    completedAt: reflection.completedAt.toISOString()
  };
}
