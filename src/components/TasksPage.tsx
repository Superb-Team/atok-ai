import React, { useState, useEffect } from 'react';
import { CheckCircle2, Circle, Clock, GripVertical } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { taskService } from '@/services/task.service';
import { authService } from '@/services/auth.service';
import type { Task as DBTask, TaskPositionUpdate } from '@/types/task.types';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
  useDroppable,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Task {
  id: number;
  title: string;
  duration: string;
  completed: boolean;
  date?: string;
  dbTask: DBTask;
}

interface Column {
  id: string;
  title: string;
  tasks: Task[];
  color: string;
}

interface SortableTaskProps {
  task: Task;
  columnId: string;
  toggleTaskCompletion: (columnId: string, taskId: number) => void;
}

const SortableTask: React.FC<SortableTaskProps> = ({ task, columnId, toggleTaskCompletion }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group rounded-lg border border-border bg-background p-3 transition-all hover:border-ring/35 hover:shadow-sm cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <GripVertical className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0 transition-colors group-hover:text-muted-foreground" strokeWidth={1.75} />
            <h3 className={`text-[13px] font-medium truncate ${task.completed ? 'line-through text-muted-foreground/60' : 'text-foreground'}`}>
              {task.title}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 ml-[22px] mt-1">
            <Clock className="w-3 h-3 text-muted-foreground/60 flex-shrink-0" strokeWidth={1.75} />
            <span className="font-mono text-[11px] text-muted-foreground">
              {task.duration}
            </span>
          </div>
        </div>
        <button
          onClick={() => toggleTaskCompletion(columnId, task.id)}
          className="p-1.5 hover:bg-accent rounded-md transition-colors flex-shrink-0 active:scale-95"
          aria-label={task.completed ? 'Mark as not done' : 'Mark as done'}
        >
          {task.completed ? (
            <CheckCircle2 className="w-4 h-4 text-primary" strokeWidth={1.75} />
          ) : (
            <Circle className="w-4 h-4 text-muted-foreground/50 hover:text-foreground" strokeWidth={1.75} />
          )}
        </button>
      </div>
    </div>
  );
};

interface DroppableColumnProps {
  column: Column;
  children: React.ReactNode;
}

const DroppableColumn: React.FC<DroppableColumnProps> = ({ column, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 overflow-y-auto space-y-2 mb-3 pr-1 min-h-[200px] rounded-lg transition-colors ${
        isOver ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''
      }`}
    >
      {children}
    </div>
  );
};

const TasksPage: React.FC = () => {
  const [columns, setColumns] = useState<Column[]>([
    { id: 'backlog', title: 'Backlog', color: 'gray', tasks: [] },
    { id: 'this_week', title: 'This Week', color: 'blue', tasks: [] },
    { id: 'today', title: 'Today', color: 'blue', tasks: [] },
    { id: 'done', title: 'Done', color: 'green', tasks: [] }
  ]);

  const [newTaskInput, setNewTaskInput] = useState<{ [key: string]: string }>({});
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
    try {
      const user = authService.getUser();
      if (!user) return;

      const dbTasks = await taskService.getTasks(user.id);

      const tasksByStatus: { [key: string]: Task[] } = {
        backlog: [],
        this_week: [],
        today: [],
        done: []
      };

      dbTasks.forEach(dbTask => {
        const task: Task = {
          id: dbTask.id,
          title: dbTask.title,
          duration: dbTask.duration_minutes ? `${dbTask.duration_minutes} Min` : '20 Min',
          completed: !!dbTask.completed_at,
          date: dbTask.completed_at ? new Date(dbTask.completed_at).toLocaleDateString('en-US', { 
            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
          }) : undefined,
          dbTask
        };
        tasksByStatus[dbTask.status]?.push(task);
      });

      setColumns(prev => prev.map(col => ({
        ...col,
        tasks: tasksByStatus[col.id] || []
      })));
    } catch (error) {
      console.error('Failed to load tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as number);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as number;
    const overId = over.id;

    const activeColumn = columns.find(col =>
      col.tasks.some(task => task.id === activeId)
    );

    let overColumn = columns.find(col => col.id === overId);
    if (!overColumn) {
      overColumn = columns.find(col => 
        col.tasks.some(task => task.id === overId)
      );
    }

    if (!activeColumn || !overColumn) return;
    if (activeColumn.id === overColumn.id) return;

    setColumns(prev => {
      const activeItems = activeColumn.tasks;
      const overItems = overColumn.tasks;

      const activeIndex = activeItems.findIndex(task => task.id === activeId);
      const overIndex = overItems.findIndex(task => task.id === overId);

      let newIndex: number;
      if (overId === overColumn.id) {
        newIndex = overItems.length;
      } else {
        const isBelowLastItem = over && overIndex === overItems.length - 1;
        const modifier = isBelowLastItem ? 1 : 0;
        newIndex = overIndex >= 0 ? overIndex + modifier : overItems.length;
      }

      return prev.map(col => {
        if (col.id === activeColumn.id) {
          return {
            ...col,
            tasks: col.tasks.filter(task => task.id !== activeId)
          };
        }
        if (col.id === overColumn.id) {
          const newTasks = [...col.tasks];
          newTasks.splice(newIndex, 0, activeItems[activeIndex]);
          return {
            ...col,
            tasks: newTasks
          };
        }
        return col;
      });
    });
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) {
      setActiveId(null);
      return;
    }

    const activeId = active.id as number;
    const overId = over.id;

    const activeColumn = columns.find(col => 
      col.tasks.some(task => task.id === activeId)
    );

    if (!activeColumn) {
      setActiveId(null);
      return;
    }

    const activeIndex = activeColumn.tasks.findIndex(task => task.id === activeId);
    const overIndex = activeColumn.tasks.findIndex(task => task.id === overId);

    if (activeIndex !== overIndex && activeIndex !== -1 && overIndex !== -1) {
      setColumns(prev => prev.map(col => {
        if (col.id === activeColumn.id) {
          return {
            ...col,
            tasks: arrayMove(col.tasks, activeIndex, overIndex)
          };
        }
        return col;
      }));
    }

    await saveTaskPositions();
    setActiveId(null);
  };

  const saveTaskPositions = async () => {
    try {
      const user = authService.getUser();
      if (!user) return;

      const updates: TaskPositionUpdate[] = [];
      columns.forEach(col => {
        col.tasks.forEach((task, index) => {
          updates.push({
            id: task.id,
            position: index,
            status: col.id
          });
        });
      });

      await taskService.updateTaskPositions(user.id, updates);
    } catch (error) {
      console.error('Failed to save task positions:', error);
    }
  };

  const addTask = async (columnId: string) => {
    const taskTitle = newTaskInput[columnId]?.trim();
    if (!taskTitle) return;

    try {
      const user = authService.getUser();
      if (!user) return;

      const dbTask = await taskService.createTask(user.id, {
        title: taskTitle,
        status: columnId,
        duration_minutes: 20
      });

      const newTask: Task = {
        id: dbTask.id,
        title: dbTask.title,
        duration: `${dbTask.duration_minutes || 20} Min`,
        completed: false,
        dbTask
      };

      setColumns(prev => prev.map(col => 
        col.id === columnId 
          ? { ...col, tasks: [...col.tasks, newTask] }
          : col
      ));

      setNewTaskInput(prev => ({ ...prev, [columnId]: '' }));
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  const clearAllTasks = async (columnId: string) => {
    try {
      const user = authService.getUser();
      if (!user) return;

      await taskService.clearColumnTasks(user.id, columnId);
      
      setColumns(prev => prev.map(col => 
        col.id === columnId 
          ? { ...col, tasks: [] }
          : col
      ));
    } catch (error) {
      console.error('Failed to clear tasks:', error);
    }
  };

  const toggleTaskCompletion = async (columnId: string, taskId: number) => {
    try {
      const user = authService.getUser();
      if (!user) return;

      await taskService.toggleTaskCompletion(taskId, user.id);
      
      setColumns(prev => prev.map(col => {
        if (col.id === columnId) {
          return {
            ...col,
            tasks: col.tasks.map(task => 
              task.id === taskId 
                ? { ...task, completed: !task.completed }
                : task
            )
          };
        }
        return col;
      }));
    } catch (error) {
      console.error('Failed to toggle task completion:', error);
    }
  };

  const getTaskCount = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    return column?.tasks.length || 0;
  };

  const getProgressPercentage = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    if (!column || column.tasks.length === 0) return 0;
    const completed = column.tasks.filter(t => t.completed).length;
    return Math.round((completed / column.tasks.length) * 100);
  };

  const getCompletedCount = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    if (!column) return 0;
    return column.tasks.filter(t => t.completed).length;
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 h-screen overflow-y-auto overflow-x-hidden bg-background px-10 pb-16 pt-9">
        <div className="max-w-7xl mx-auto">
          <header className="mb-8">
            <h1 className="font-display text-[2rem] font-semibold leading-tight tracking-tight text-foreground">Tasks</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Plan the week, then drag things toward done.
            </p>
          </header>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5 lg:gap-6">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-[500px] animate-pulse rounded-xl border border-border bg-card md:h-[560px] lg:h-[620px]" />
              ))
            ) : (
              columns.map(column => (
                <div
                  key={column.id}
                  id={column.id}
                  className="bg-card rounded-xl p-4 border border-border flex flex-col h-[500px] md:h-[560px] lg:h-[620px]"
                >
                {/* Column Header */}
                <div className="mb-3">
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <h2 className="font-display text-[15px] font-semibold text-foreground">
                      {column.title}
                    </h2>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {getTaskCount(column.id)}
                    </span>
                  </div>

                  {(column.id === 'this_week' || column.id === 'today') && getTaskCount(column.id) > 0 && (
                    <div className="mb-1 flex items-center gap-2.5">
                      <Progress value={getProgressPercentage(column.id)} className="h-1.5 flex-1" />
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {getCompletedCount(column.id)}/{getTaskCount(column.id)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Add Task Input */}
                <div className="mb-3">
                  <input
                    type="text"
                    data-column={column.id}
                    placeholder="Add a task, press Enter"
                    value={newTaskInput[column.id] || ''}
                    onChange={(e) => setNewTaskInput(prev => ({ ...prev, [column.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        addTask(column.id);
                      }
                    }}
                    className="w-full px-3 py-2 bg-background border border-input rounded-lg outline-none text-[13px] placeholder:text-muted-foreground/60 transition-colors focus:border-ring/60 focus:ring-2 focus:ring-ring/20"
                  />
                </div>

                {/* Droppable Tasks List - Make entire area droppable */}
                <SortableContext
                  items={column.tasks.map(task => task.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <DroppableColumn column={column}>
                    {column.tasks.length === 0 ? (
                      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground/70">
                        Drop a task here
                      </div>
                    ) : (
                      column.tasks.map((task) => (
                        <SortableTask
                          key={task.id}
                          task={task}
                          columnId={column.id}
                          toggleTaskCompletion={toggleTaskCompletion}
                        />
                      ))
                    )}
                  </DroppableColumn>
                </SortableContext>

                {/* Clear All Button */}
                {column.tasks.length > 0 && (
                  <Button
                    onClick={() => clearAllTasks(column.id)}
                    variant="ghost"
                    className="mt-auto w-full text-xs text-muted-foreground hover:text-foreground"
                    size="sm"
                  >
                    Clear column
                  </Button>
                )}
              </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Drag Overlay */}
      <DragOverlay>
        {activeId ? (
          <div className="rounded-lg border border-ring/40 bg-card p-3 shadow-lg rotate-2 opacity-95">
            <div className="flex items-center gap-2">
              <GripVertical className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
              <span className="text-[13px] font-medium text-foreground">
                {columns.flatMap(col => col.tasks).find(task => task.id === activeId)?.title}
              </span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

export default TasksPage;
